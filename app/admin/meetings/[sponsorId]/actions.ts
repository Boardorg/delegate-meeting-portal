"use server";

import { and, eq, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { meetingRequests, scheduledMeetings, type ScheduledMeetingRow } from "@/lib/db/schema";
import { loadAttendees } from "@/lib/attendees/loader";
import type { MeetingMatchKind, MeetingSource } from "@/types";

// ---------------------------------------------------------------------------
// Server actions for /admin/meetings/[sponsorId] — the per-sponsor meeting
// detail page.
//
// getMeetingDetail is the primary read action: it loads the sponsor's profile
// and their scheduled meetings for the event, resolving delegate names from
// the attendee data source.
// ---------------------------------------------------------------------------

/** Header data for the sponsor detail panel. */
export type SponsorDetail = {
    salesforceId: string;
    company: string;
    name: string;
    title: string;
    sponsorTier: "diamond" | "standard";
    contracted: number;
    bonus: number;
    requestCount: number;
    scheduledCount: number;
};

/** Derived Cvent sync status for a single meeting row. */
export type SyncStatus = "synced" | "modified" | "not_pushed";

/** One row in the per-sponsor meeting table. */
export type MeetingRow = {
    id: string;
    delegateSalesforceId: string;
    delegateName: string;
    delegateCompany: string;
    matchKind: MeetingMatchKind;
    rank: number | null;
    startTime: string | null;
    endTime: string | null;
    slotIdA: string;
    slotIdB: string;
    location: string | null;
    syncStatus: SyncStatus;
    source: MeetingSource;
    cventAppointmentId: string | null;
};

/**
 * Derives the Cvent sync status for a DB meeting row.
 * Not pushed if cventAppointmentId is null. Modified if the meeting was
 * edited after it was last pushed. Synced otherwise.
 */
function getSyncStatus(m: ScheduledMeetingRow): SyncStatus {
    if (!m.cventAppointmentId) return "not_pushed";
    if (
        m.lastModifiedAt &&
        m.lastPushedAt &&
        m.lastModifiedAt > m.lastPushedAt
    )
        return "modified";
    return "synced";
}

/**
 * Loads the sponsor profile and all of their scheduled meetings for one event,
 * with delegate names resolved from the attendee data source.
 *
 * Returns null when the sponsorId does not resolve to a known sponsor for
 * the event (triggers a 404 in the page component).
 *
 * @param {{ sponsorId: string; eventCode: string }} params
 * @returns {Promise<{ sponsor: SponsorDetail; meetings: MeetingRow[] } | null>}
 */
export async function getMeetingDetail(params: {
    sponsorId: string;
    eventCode: string;
}): Promise<{ sponsor: SponsorDetail; meetings: MeetingRow[] } | null> {
    const [attendees, meetingRows, requestRows] = await Promise.all([
        loadAttendees(false, params.eventCode),
        db
            .select()
            .from(scheduledMeetings)
            .where(
                and(
                    eq(scheduledMeetings.eventCode, params.eventCode),
                    or(
                        eq(scheduledMeetings.attendeeA, params.sponsorId),
                        eq(scheduledMeetings.attendeeB, params.sponsorId),
                    ),
                ),
            ),
        db
            .select({ id: meetingRequests.id })
            .from(meetingRequests)
            .where(
                and(
                    eq(meetingRequests.eventCode, params.eventCode),
                    eq(meetingRequests.requesterId, params.sponsorId),
                ),
            ),
    ]);

    const sponsor = attendees.find(
        (a) => a.salesforceId === params.sponsorId && a.role === "sponsor",
    );
    if (!sponsor) return null;

    const attendeeMap = new Map(attendees.map((a) => [a.salesforceId, a]));

    const contracted = sponsor.sponsorTier === "diamond" ? 8 : 5;
    const bonus = 0;

    const meetings: MeetingRow[] = meetingRows
        .map((m) => {
            const delegateId =
                m.attendeeA === params.sponsorId ? m.attendeeB : m.attendeeA;
            const delegate = attendeeMap.get(delegateId);
            return {
                id: m.id,
                delegateSalesforceId: delegateId,
                delegateName: delegate?.name ?? delegateId,
                delegateCompany: delegate?.company ?? "",
                matchKind: m.matchKind as MeetingMatchKind,
                rank: m.rank,
                startTime: m.startTime,
                endTime: m.endTime,
                slotIdA: m.slotIdA,
                slotIdB: m.slotIdB,
                location: m.location,
                syncStatus: getSyncStatus(m),
                source: m.source as MeetingSource,
                cventAppointmentId: m.cventAppointmentId,
            };
        })
        .sort((a, b) => {
            if (!a.startTime) return 1;
            if (!b.startTime) return -1;
            return a.startTime.localeCompare(b.startTime);
        });

    return {
        sponsor: {
            salesforceId: sponsor.salesforceId,
            company: sponsor.company,
            name: sponsor.name,
            title: sponsor.title,
            sponsorTier: sponsor.sponsorTier === "diamond" ? "diamond" : "standard",
            contracted,
            bonus,
            requestCount: requestRows.length,
            scheduledCount: meetingRows.length,
        },
        meetings,
    };
}
