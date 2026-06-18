"use server";

import { and, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { meetingRequests, scheduledMeetings, type NewScheduledMeeting } from "@/lib/db/schema";
import { loadAttendees } from "@/lib/attendees/loader";
import { runScheduler } from "@/lib/scheduling/engine";
import { pairKey } from "@/lib/scheduling/helpers";
import { loadMockRequests } from "@/lib/scheduling/loader";
import { paginate, type Page } from "@/lib/admin/pagination";
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
        contracted: s.sponsorTier === "diamond" ? 8 : 5,
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
 * with the fresh engine output. Meetings already pushed to Cvent are preserved: they
 * are passed to the engine so they count against per-attendee caps and have their slots
 * blocked, but they are not deleted or re-inserted.
 *
 * ID translation: DB rows store Salesforce IDs; the engine uses Attendee.id (which may
 * differ in mock mode). Requests and preserved meetings are remapped to engine IDs before
 * the run, and newly scheduled meetings are remapped back to Salesforce IDs before insert.
 *
 * @param {string} eventCode - The event to schedule meetings for.
 * @returns {Promise<{ inserted: number }>} Count of newly scheduled meetings written to the DB.
 */
export async function runSchedulerForEvent(
    eventCode: string,
): Promise<{ inserted: number }> {
    // TODO: Once the Cvent slot integration is wired up (see attendeeMapper.ts),
    // attendees will carry real availability data and the engine will produce
    // meetings. Until then, scheduling.slots is [] for all real attendees and
    // the engine will always return an empty schedule with USE_MOCK=false.

    const isMock = process.env.USE_MOCK === "true";
    const mockRequestsPath = `${process.cwd()}/data/mock/requests.json`;

    // Load attendees and already-pushed meetings in parallel. Requests are loaded
    // separately since their source depends on whether mock mode is active.
    const [attendees, pushedRows] = await Promise.all([
        loadAttendees(false, eventCode),
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

    // Build bidirectional ID maps for mock-mode compatibility.
    // When USE_MOCK=true, Attendee.id ("s1") !== Attendee.salesforceId (Salesforce record id).
    // In production they are identical, so these maps are identity functions.
    const sfToEngineId = new Map(attendees.map((a) => [a.salesforceId, a.id]));
    const engineIdToSf = new Map(attendees.map((a) => [a.id, a.salesforceId]));

    // In mock mode, requests come from the file (already in engine ID format).
    // In production, requests come from the DB and are remapped from Salesforce IDs.
    const engineRequests: MeetingRequest[] = isMock
        ? await loadMockRequests(mockRequestsPath)
        : (await db.select().from(meetingRequests).where(eq(meetingRequests.eventCode, eventCode))).map((r) => ({
              id: String(r.id),
              requesterId: sfToEngineId.get(r.requesterId) ?? r.requesterId,
              targetId: sfToEngineId.get(r.targetId) ?? r.targetId,
              rank: r.rank,
          }));

    // Run the engine freely with no knowledge of pushed meetings. This keeps the output
    // deterministic — pushed meetings influence it only via post-reconciliation below.
    const { schedule } = await runScheduler(attendees, engineRequests);

    // Build reconciliation sets from pushed meetings (using engine IDs for comparison).
    // A pushed meeting wins over any conflicting fresh meeting from the engine.
    const pushedPairs = new Set<string>();
    const blockedSlots = new Set<string>(); // "${attendeeId}:${slotId}"
    for (const row of pushedRows) {
        const a = sfToEngineId.get(row.attendeeA) ?? row.attendeeA;
        const b = sfToEngineId.get(row.attendeeB) ?? row.attendeeB;
        pushedPairs.add(pairKey(a, b));
        blockedSlots.add(`${a}:${row.slotIdA}`);
        blockedSlots.add(`${b}:${row.slotIdB}`);
    }

    // Drop any fresh meeting that duplicates a pushed pair or uses a slot already held
    // by a pushed meeting. Everything else is safe to insert.
    const reconciledSchedule = schedule.filter((m) => {
        if (pushedPairs.has(pairKey(m.attendeeA, m.attendeeB))) return false;
        if (blockedSlots.has(`${m.attendeeA}:${m.slotIdA}`)) return false;
        if (blockedSlots.has(`${m.attendeeB}:${m.slotIdB}`)) return false;
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

    // Insert the reconciled schedule, mapping engine IDs back to Salesforce IDs for storage.
    if (reconciledSchedule.length > 0) {
        const toInsert: NewScheduledMeeting[] = reconciledSchedule.map((m) => ({
            id: m.id,
            eventCode,
            // Convert engine IDs back to Salesforce IDs for storage.
            attendeeA: engineIdToSf.get(m.attendeeA) ?? m.attendeeA,
            attendeeB: engineIdToSf.get(m.attendeeB) ?? m.attendeeB,
            day: m.day,
            slotIdA: m.slotIdA,
            slotIdB: m.slotIdB,
            passNumber: m.passNumber,
            mutual: m.mutual,
            matchKind: m.matchKind,
            rank: m.rank,
            source: m.source,
            location: m.location,
            startTime: m.startTime,
            endTime: m.endTime,
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
 * Pushes all un-synced portal meetings for an entire event. Covers both
 * not-yet-pushed meetings and meetings edited since their last push.
 * Like pushMeeting, this writes stub Cvent IDs — replace with real API
 * calls when the Cvent integration is wired up.
 *
 * @param {string} eventCode - The event to push meetings for.
 * @returns {Promise<{ pushed: number }>} Count of meetings updated.
 */
export async function pushAllForEvent(
    eventCode: string,
): Promise<{ pushed: number }> {
    // Load all un-synced portal meetings for this event.
    const rows = await db
        .select({ id: scheduledMeetings.id })
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

    // Set the current timestamp for creating stub Cvent appointment IDs and recording push time.
    // TODO: Replace this block with a real Cvent API call per meeting.
    const now = new Date();

    // Iterate through the meetings and update each with a stub Cvent appointment ID and lastPushedAt timestamp.
    for (const row of rows) {
        // TODO: Replace this inner block with a real Cvent API call per meeting.
        // Same as pushMeeting: create or update the Cvent appointment and write
        // back the real appointment ID. Consider batching if the API supports it.
        await db
            .update(scheduledMeetings)
            .set({
                cventAppointmentId: `stub-${row.id}-${now.getTime()}`,
                lastPushedAt: now,
            })
            .where(eq(scheduledMeetings.id, row.id));
    }

    // Revalidate the admin meetings page to reflect the updated push status.
    revalidatePath("/admin/meetings");
    return { pushed: rows.length };
}
