"use server";

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { meetingRequests, scheduledMeetings, type NewScheduledMeeting } from "@/lib/db/schema";
import { loadAttendees } from "@/lib/attendees/loader";
import { runScheduler } from "@/lib/scheduling/engine";
import { paginate, type Page } from "@/lib/admin/pagination";
import type { MeetingMatchKind, MeetingRequest, MeetingSource, ScheduledMeeting } from "@/types";

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
    const [fromRequests, fromMeetings] = await Promise.all([
        db.selectDistinct({ eventCode: meetingRequests.eventCode }).from(meetingRequests),
        db.selectDistinct({ eventCode: scheduledMeetings.eventCode }).from(scheduledMeetings),
    ]);
    const codes = new Set([
        ...fromRequests.map((r) => r.eventCode),
        ...fromMeetings.map((r) => r.eventCode),
    ]);
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

    const requestCountMap = new Map<string, number>();
    for (const r of requestRows) {
        requestCountMap.set(r.requesterId, (requestCountMap.get(r.requesterId) ?? 0) + 1);
    }

    const scheduledCountMap = new Map<string, number>();
    for (const m of meetingRows) {
        scheduledCountMap.set(m.attendeeA, (scheduledCountMap.get(m.attendeeA) ?? 0) + 1);
        scheduledCountMap.set(m.attendeeB, (scheduledCountMap.get(m.attendeeB) ?? 0) + 1);
    }

    const sponsors = attendees.filter((a) => a.role === "sponsor" && a.salesforceId);

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

    const q = (params.q ?? "").trim().toLowerCase();
    if (q) {
        rows = rows.filter(
            (r) =>
                r.company.toLowerCase().includes(q) ||
                r.name.toLowerCase().includes(q),
        );
    }

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

    const total = rows.length;
    const { page, pageSize, pageCount, offset } = paginate(total, params);

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
    const [attendees, requestRows, pushedRows] = await Promise.all([
        loadAttendees(false, eventCode),
        db.select().from(meetingRequests).where(eq(meetingRequests.eventCode, eventCode)),
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

    // Remap DB requests from Salesforce IDs → engine Attendee.id.
    const engineRequests: MeetingRequest[] = requestRows.map((r) => ({
        id: String(r.id),
        requesterId: sfToEngineId.get(r.requesterId) ?? r.requesterId,
        targetId: sfToEngineId.get(r.targetId) ?? r.targetId,
        rank: r.rank,
    }));

    // Convert pushed DB rows to ScheduledMeeting objects with engine IDs so the engine
    // can match them against attendees for cap-counting and slot-blocking.
    const preservedMeetings: ScheduledMeeting[] = pushedRows.map((r) => ({
        id: r.id,
        attendeeA: sfToEngineId.get(r.attendeeA) ?? r.attendeeA,
        attendeeB: sfToEngineId.get(r.attendeeB) ?? r.attendeeB,
        day: r.day as 1 | 2,
        slotIdA: r.slotIdA,
        slotIdB: r.slotIdB,
        passNumber: r.passNumber,
        mutual: r.mutual,
        matchKind: r.matchKind as MeetingMatchKind,
        rank: r.rank,
        source: r.source as MeetingSource,
        location: r.location,
        startTime: r.startTime,
        endTime: r.endTime,
        cventAppointmentId: r.cventAppointmentId,
        lastModifiedAt: r.lastModifiedAt?.toISOString() ?? null,
        lastPushedAt: r.lastPushedAt?.toISOString() ?? null,
    }));

    const { schedule } = await runScheduler(attendees, engineRequests, preservedMeetings);

    // Replace all un-pushed portal meetings for this event with the fresh engine output.
    await db.delete(scheduledMeetings).where(
        and(
            eq(scheduledMeetings.eventCode, eventCode),
            eq(scheduledMeetings.source, "portal"),
            isNull(scheduledMeetings.cventAppointmentId),
        ),
    );

    if (schedule.length > 0) {
        const toInsert: NewScheduledMeeting[] = schedule.map((m) => ({
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

    revalidatePath("/admin/meetings");
    return { inserted: schedule.length };
}
