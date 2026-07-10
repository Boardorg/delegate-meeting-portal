"use server";

import { and, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { meetingRequests, scheduledMeetings, type NewScheduledMeeting } from "@/lib/db/schema";
import { loadAttendees } from "@/lib/attendees/loader";
import { loadEventScheduleData } from "@/lib/cvent/mapper";
import { createAppointment, updateAppointment } from "@/lib/cvent/client";
import { runScheduler } from "@/lib/scheduling/engine";
import { pairKey } from "@/lib/scheduling/helpers";
import { loadMockRequests } from "@/lib/scheduling/loader";
import { paginate, type Page } from "@/lib/admin/pagination";
import { contractedMeetings } from "@/lib/attendees/caps";
import type { MeetingRequest } from "@/types";

// ---------------------------------------------------------------------------
// Server actions for /admin/meetings — the sponsor list page.
//
// Reads pull from both the meetingRequests table (request counts) and the
// scheduledMeetings table (scheduled counts). Sponsor profiles come from
// the attendee loader (Salesforce or mock, depending on USE_MOCK).
//
// Contracted meeting counts are derived from sponsorTier (diamond: 8,
// standard: 5). Bonus meetings are not yet in the attendee data source and
// show as 0 until that field is available from Salesforce.
// ---------------------------------------------------------------------------

/**
 * Returns distinct event codes present in either the meeting requests or
 * scheduled meetings tables, sorted alphabetically.
 *
 * @returns {Promise<string[]>} Sorted list of event codes.
 */
export async function listMeetingsEventCodes(): Promise<string[]> {
    // In mock mode, return a fixed event code from the mock data.
    if (process.env.USE_MOCK === "true") {
        return ["PARTY1999"];
    }

    // Get distinct event codes from both tables in parallel.
    const [fromRequests, fromMeetings] = await Promise.all([
        db.selectDistinct({ eventCode: meetingRequests.eventCode }).from(meetingRequests),
        db.selectDistinct({ eventCode: scheduledMeetings.eventCode }).from(scheduledMeetings),
    ]);

    // Combine event codes from both sources into a single set to ensure uniqueness.
    const codes = new Set([
        ...fromRequests.map((r) => r.eventCode),
        ...fromMeetings.map((r) => r.eventCode),
    ]);

    // Convert the set to an array and sort alphabetically.
    return [...codes].sort();
}

/** One sponsor row as returned to the client table. */
export type SponsorRow = {
    salesforceId: string;
    company: string;
    name: string;
    title: string;
    sponsorTier: "diamond" | "standard";
    /** Package meetings guaranteed by tier. Diamond: 8, Standard: 5. */
    contracted: number;
    /** Bonus meetings beyond the package. Not yet in attendee data; always 0. */
    bonus: number;
    requestCount: number;
    scheduledCount: number;
};

/** Columns the sponsor list can be sorted by. */
export type SponsorSortField =
    | "company"
    | "name"
    | "tier"
    | "requestCount"
    | "scheduledCount";

export type SponsorsPage = Page<SponsorRow>;

/**
 * Returns a sorted, searched, paginated page of sponsors for an event,
 * with their request and scheduled meeting counts attached.
 *
 * @param {{ eventCode: string; q?: string; sortField?: SponsorSortField; sortDir?: "asc" | "desc"; page?: number }} params
 * @returns {Promise<SponsorsPage>} The page of sponsor rows plus totals.
 */
export async function listSponsorsPage(params: {
    eventCode: string;
    q?: string;
    sortField?: SponsorSortField;
    sortDir?: "asc" | "desc";
    page?: number;
}): Promise<SponsorsPage> {
    // Get all attendees, meeting requests, and scheduled meetings for this event in parallel.
    const [attendees, requestRows, meetingRows] = await Promise.all([
        loadAttendees(false, params.eventCode),
        db
            .select({ requesterId: meetingRequests.requesterId })
            .from(meetingRequests)
            .where(eq(meetingRequests.eventCode, params.eventCode)),
        db
            .select({
                attendeeA: scheduledMeetings.attendeeA,
                attendeeB: scheduledMeetings.attendeeB,
            })
            .from(scheduledMeetings)
            .where(eq(scheduledMeetings.eventCode, params.eventCode)),
    ]);

    // Build a map of request counts keyed by attendee ID.
    const requestCountMap = new Map<string, number>();
    for (const r of requestRows) {
        requestCountMap.set(r.requesterId, (requestCountMap.get(r.requesterId) ?? 0) + 1);
    }

    // Build a map of scheduled meeting counts keyed by attendee ID.
    const scheduledCountMap = new Map<string, number>();
    for (const m of meetingRows) {
        scheduledCountMap.set(m.attendeeA, (scheduledCountMap.get(m.attendeeA) ?? 0) + 1);
        scheduledCountMap.set(m.attendeeB, (scheduledCountMap.get(m.attendeeB) ?? 0) + 1);
    }

    // Filter attendees to only include sponsors with a Salesforce ID.
    const sponsors = attendees.filter((a) => a.role === "sponsor" && a.salesforceId);

    // Map sponsors to SponsorRow, attaching request and scheduled counts from the maps.
    let rows: SponsorRow[] = sponsors.map((s) => ({
        salesforceId: s.salesforceId,
        company: s.company,
        name: s.name,
        title: s.title,
        sponsorTier: s.sponsorTier === "diamond" ? "diamond" : "standard",
        contracted: contractedMeetings(s.sponsorTier),
        bonus: 0,
        requestCount: requestCountMap.get(s.salesforceId) ?? 0,
        scheduledCount: scheduledCountMap.get(s.salesforceId) ?? 0,
    }));

    // Apply search filter if q is provided. Search matches company or name, case-insensitive.
    const q = (params.q ?? "").trim().toLowerCase();
    if (q) {
        rows = rows.filter(
            (r) =>
                r.company.toLowerCase().includes(q) ||
                r.name.toLowerCase().includes(q),
        );
    }

    // Apply sorting if sortField is provided.
    const dir = params.sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
        switch (params.sortField) {
            case "name":
                return dir * a.name.localeCompare(b.name);
            case "tier":
                return dir * a.sponsorTier.localeCompare(b.sponsorTier);
            case "requestCount":
                return dir * (a.requestCount - b.requestCount);
            case "scheduledCount":
                return dir * (a.scheduledCount - b.scheduledCount);
            default:
                return dir * a.company.localeCompare(b.company);
        }
    });

    // Paginate the results.
    const total = rows.length;
    const { page, pageSize, pageCount, offset } = paginate(total, params);

    // Return the paginated slice along with totals and metadata.
    return {
        rows: rows.slice(offset, offset + pageSize),
        total,
        page,
        pageSize,
        pageCount,
    };
}

/**
 * Runs the scheduling engine for an event and replaces all un-pushed portal meetings
 * with the fresh engine output. Meetings already pushed to Cvent are preserved via
 * post-reconciliation: the engine runs freely, then any fresh meeting that duplicates
 * or conflicts with a pushed meeting is dropped before insert.
 *
 * The engine uses Salesforce IDs throughout, matching what the DB stores, so no ID
 * translation is needed in either mock or production mode.
 *
 * @param {string} eventCode - The event to schedule meetings for.
 * @returns {Promise<{ inserted: number }>} Count of newly scheduled meetings written to the DB.
 */
export async function runSchedulerForEvent(
    eventCode: string,
): Promise<{ inserted: number }> {
    const isMock = process.env.USE_MOCK === "true";
    const mockRequestsPath = `${process.cwd()}/data/mock/requests.json`;

    // Load attendees, requests, the event's Cvent availability, and already-pushed meetings.
    const [attendees, requestRows, scheduleData, pushedRows] = await Promise.all([
        loadAttendees(false, eventCode),
        isMock
            ? loadMockRequests(mockRequestsPath)
            : db.select().from(meetingRequests).where(eq(meetingRequests.eventCode, eventCode)),
        loadEventScheduleData(eventCode),
        db
            .select()
            .from(scheduledMeetings)
            .where(
                and(
                    eq(scheduledMeetings.eventCode, eventCode),
                    isNotNull(scheduledMeetings.cventAppointmentId),
                ),
            ),
    ]);

    const engineRequests: MeetingRequest[] = requestRows.map((r) => ({
        id: String(r.id),
        requesterId: r.requesterId,
        targetId: r.targetId,
        rank: r.rank,
    }));

    // Run the engine freely with no knowledge of pushed meetings. This keeps the output
    // deterministic — pushed meetings influence it only via post-reconciliation below.
    const { schedule } = await runScheduler(
        attendees,
        engineRequests,
        scheduleData.timeslots,
        scheduleData.locations,
    );

    // Build reconciliation sets from pushed meetings. Salesforce IDs are used throughout
    // so no conversion is needed here.
    const pushedPairs = new Set<string>();
    const blockedSlots = new Set<string>(); // "${attendeeId}:${timeslotId}"
    for (const row of pushedRows) {
        pushedPairs.add(pairKey(row.attendeeA, row.attendeeB));
        blockedSlots.add(`${row.attendeeA}:${row.timeslotId}`);
        blockedSlots.add(`${row.attendeeB}:${row.timeslotId}`);
    }

    // Drop any fresh meeting that duplicates a pushed pair or reuses a timeslot already
    // held by a pushed meeting for either attendee. Everything else is safe to insert.
    const reconciledSchedule = schedule.filter((m) => {
        if (pushedPairs.has(pairKey(m.attendeeA, m.attendeeB))) return false;
        if (blockedSlots.has(`${m.attendeeA}:${m.timeslotId}`)) return false;
        if (blockedSlots.has(`${m.attendeeB}:${m.timeslotId}`)) return false;
        return true;
    });

    // Replace all un-pushed portal meetings for this event with the reconciled output.
    await db.delete(scheduledMeetings).where(
        and(
            eq(scheduledMeetings.eventCode, eventCode),
            eq(scheduledMeetings.source, "portal"),
            isNull(scheduledMeetings.cventAppointmentId),
        ),
    );

    if (reconciledSchedule.length > 0) {
        const toInsert: NewScheduledMeeting[] = reconciledSchedule.map((m) => ({
            id: m.id,
            eventCode,
            attendeeA: m.attendeeA,
            attendeeB: m.attendeeB,
            day: m.day,
            timeslotId: m.timeslotId,
            passNumber: m.passNumber,
            mutual: m.mutual,
            matchKind: m.matchKind,
            rank: m.rank,
            source: m.source,
            locationId: m.locationId,
            cventAppointmentId: null,
            lastModifiedAt: null,
            lastPushedAt: null,
        }));
        await db.insert(scheduledMeetings).values(toInsert);
    }

    // Revalidate the admin meetings page to reflect the new schedule.
    revalidatePath("/admin/meetings");
    return { inserted: reconciledSchedule.length };
}

/**
 * Pushes all un-synced portal meetings for an entire event to Cvent. Covers
 * both not-yet-pushed meetings (createAppointment) and meetings edited since
 * their last push (updateAppointment). Each meeting's time is resolved from its
 * Cvent timeslot, and participants are mapped from Salesforce ids to Cvent
 * contact ids. Per-meeting failures are logged and skipped so one bad row
 * doesn't abort the whole push.
 *
 * @param {string} eventCode - The event to push meetings for.
 * @returns {Promise<{ pushed: number }>} Count of meetings successfully pushed.
 */
export async function pushAllForEvent(
    eventCode: string,
): Promise<{ pushed: number }> {
    // Load all un-synced portal meetings for this event (full rows — we need the
    // participants, timeslot, and location to build the Cvent appointment).
    const rows = await db
        .select()
        .from(scheduledMeetings)
        .where(
            and(
                eq(scheduledMeetings.eventCode, eventCode),
                eq(scheduledMeetings.source, "portal"),
                or(
                    isNull(scheduledMeetings.cventAppointmentId),
                    and(
                        isNotNull(scheduledMeetings.lastModifiedAt),
                        isNotNull(scheduledMeetings.lastPushedAt),
                        gt(scheduledMeetings.lastModifiedAt, scheduledMeetings.lastPushedAt),
                    ),
                ),
            ),
        );

    if (rows.length === 0) return { pushed: 0 };

    // Resolve timeslot times and attendee Cvent contact ids for the whole batch.
    const [scheduleData, attendees] = await Promise.all([
        loadEventScheduleData(eventCode),
        loadAttendees(false, eventCode),
    ]);
    const attendeeById = new Map(attendees.map((a) => [a.salesforceId, a]));

    let pushed = 0;
    for (const row of rows) {
        // A meeting can't be pushed without a resolvable time block.
        const timeslot = scheduleData.timeslotById.get(row.timeslotId);
        if (!timeslot) {
            console.warn(
                `pushAllForEvent: meeting ${row.id} references unknown timeslot ${row.timeslotId}; skipping.`,
            );
            continue;
        }

        const a = attendeeById.get(row.attendeeA);
        const b = attendeeById.get(row.attendeeB);
        const attendeeContactIds = [a?.cventContactId, b?.cventContactId].filter(
            (id): id is string => !!id,
        );

        const input = {
            subject: `${a?.name ?? row.attendeeA} & ${b?.name ?? row.attendeeB}`,
            startTime: new Date(timeslot.startTime),
            endTime: new Date(timeslot.endTime),
            locationId: row.locationId,
            attendeeContactIds,
            code: row.id,
        };

        try {
            // Update in place when already pushed; otherwise create a new appointment.
            const cventAppointmentId = row.cventAppointmentId
                ? await updateAppointment(eventCode, row.cventAppointmentId, input)
                : await createAppointment(eventCode, input);

            await db
                .update(scheduledMeetings)
                .set({ cventAppointmentId, lastPushedAt: new Date() })
                .where(eq(scheduledMeetings.id, row.id));
            pushed++;
        } catch (err) {
            console.error(
                `pushAllForEvent: failed to push meeting ${row.id}: ` +
                    `${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    // Revalidate the admin meetings page to reflect the updated push status.
    revalidatePath("/admin/meetings");
    return { pushed };
}
