"use server";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { meetingRequests, scheduledMeetings } from "@/lib/db/schema";
import { loadAttendees } from "@/lib/attendees/loader";
import { paginate, type Page } from "@/lib/admin/pagination";

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
