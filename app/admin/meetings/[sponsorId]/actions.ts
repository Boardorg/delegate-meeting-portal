"use server";

import { and, eq, gt, isNull, isNotNull, ne, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { meetingRequests, scheduledMeetings, type ScheduledMeetingRow } from "@/lib/db/schema";
import { loadAttendees } from "@/lib/attendees/loader";
import { contractedMeetings } from "@/lib/attendees/caps";
import type { MeetingMatchKind, MeetingSource } from "@/lib/db/schema";
import type { SponsorDetail } from "@/types";

// ---------------------------------------------------------------------------
// Server actions for /admin/meetings/[sponsorId] — the per-sponsor meeting
// detail page.
//
// getMeetingDetail is the primary read action: it loads the sponsor's profile
// and their scheduled meetings for the event, resolving delegate names from
// the attendee data source.
// ---------------------------------------------------------------------------

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

    const contracted = contractedMeetings(sponsor.sponsorTier);
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
            ...sponsor,
            sponsorTier: sponsor.sponsorTier === "diamond" ? "diamond" : "standard",
            contracted,
            bonus,
            requestCount: requestRows.length,
            scheduledCount: meetingRows.length,
        },
        meetings,
    };
}

/** One option in the slot picker inside the edit meeting modal. */
export type SlotOption = {
    slotIdA: string;
    slotIdB: string;
    day: 1 | 2;
    startTime: string;
    endTime: string;
};

/**
 * Returns the available mutual slot pairs for a meeting edit, along with the
 * meeting's current slot assignment. Used to populate the slot dropdown in the
 * edit modal.
 *
 * Slots already taken by other meetings for either attendee are excluded.
 * The current meeting's own slots are always included so the admin can
 * save without changing the time.
 *
 * @param {{ meetingId: string; eventCode: string }} params
 * @returns {Promise<{ current: SlotOption | null; options: SlotOption[] }>}
 */
export async function getSlotOptions(params: {
    meetingId: string;
    eventCode: string;
}): Promise<{ current: SlotOption | null; options: SlotOption[] }> {
    const [meetingRows, otherMeetings, attendees] = await Promise.all([
        db
            .select()
            .from(scheduledMeetings)
            .where(eq(scheduledMeetings.id, params.meetingId))
            .limit(1),
        db
            .select()
            .from(scheduledMeetings)
            .where(
                and(
                    eq(scheduledMeetings.eventCode, params.eventCode),
                    ne(scheduledMeetings.id, params.meetingId),
                ),
            ),
        loadAttendees(false, params.eventCode),
    ]);

    const meeting = meetingRows[0];
    if (!meeting) return { current: null, options: [] };

    const attA = attendees.find((a) => a.salesforceId === meeting.attendeeA);
    const attB = attendees.find((a) => a.salesforceId === meeting.attendeeB);
    if (!attA || !attB) return { current: null, options: [] };

    // Build sets of slot IDs blocked by other meetings for each attendee.
    const blockedA = new Set<string>();
    const blockedB = new Set<string>();
    for (const m of otherMeetings) {
        if (m.attendeeA === meeting.attendeeA) blockedA.add(m.slotIdA);
        if (m.attendeeB === meeting.attendeeA) blockedA.add(m.slotIdB);
        if (m.attendeeA === meeting.attendeeB) blockedB.add(m.slotIdA);
        if (m.attendeeB === meeting.attendeeB) blockedB.add(m.slotIdB);
    }

    // Find mutually available slot pairs by matching startTime on the same day.
    const options: SlotOption[] = [];
    for (const sa of attA.scheduling.slots) {
        if (sa.status !== "available" || blockedA.has(sa.slotId)) continue;
        for (const sb of attB.scheduling.slots) {
            if (sb.status !== "available" || blockedB.has(sb.slotId)) continue;
            if (sa.day === sb.day && sa.startTime === sb.startTime) {
                options.push({
                    slotIdA: sa.slotId,
                    slotIdB: sb.slotId,
                    day: sa.day,
                    startTime: sa.startTime,
                    endTime: sa.endTime,
                });
            }
        }
    }

    options.sort((a, b) => a.day - b.day || a.startTime.localeCompare(b.startTime));

    const current: SlotOption = {
        slotIdA: meeting.slotIdA,
        slotIdB: meeting.slotIdB,
        day: meeting.day as 1 | 2,
        startTime: meeting.startTime ?? "",
        endTime: meeting.endTime ?? "",
    };

    // Always include the current slot so the admin can save without changing the time.
    if (!options.some((o) => o.slotIdA === current.slotIdA && o.slotIdB === current.slotIdB)) {
        options.unshift(current);
    }

    return { current, options };
}

/**
 * Updates a portal meeting's slot assignment and location, recording the
 * edit time for sync status tracking.
 *
 * @param {{ id: string; slotIdA: string; slotIdB: string; day: 1 | 2; startTime: string; endTime: string; location: string | null }} params
 */
export async function editMeeting(params: {
    id: string;
    slotIdA: string;
    slotIdB: string;
    day: 1 | 2;
    startTime: string;
    endTime: string;
    location: string | null;
}): Promise<void> {
    await db
        .update(scheduledMeetings)
        .set({
            slotIdA: params.slotIdA,
            slotIdB: params.slotIdB,
            day: params.day,
            startTime: params.startTime,
            endTime: params.endTime,
            location: params.location?.trim() || null,
            lastModifiedAt: new Date(),
        })
        .where(
            and(
                eq(scheduledMeetings.id, params.id),
                eq(scheduledMeetings.source, "portal"),
            ),
        );
    revalidatePath("/admin/meetings", "layout");
}

/**
 * Deletes a portal meeting. The source guard prevents accidentally deleting
 * Cvent-native meetings, which are read-only in the portal.
 *
 * @param {{ id: string }} params
 */
export async function removeMeeting(params: { id: string }): Promise<void> {
    await db
        .delete(scheduledMeetings)
        .where(
            and(
                eq(scheduledMeetings.id, params.id),
                eq(scheduledMeetings.source, "portal"),
            ),
        );
    revalidatePath("/admin/meetings", "layout");
}

/**
 * Stub that marks a meeting as pushed to Cvent by writing a placeholder
 * appointment ID and recording the push time. Replace the body of this
 * function with the real Cvent API call when that integration is ready.
 *
 * @param {{ id: string }} params
 */
export async function pushMeeting(params: { id: string }): Promise<void> {
    // TODO: Replace this block with a real Cvent API call.
    // Call the Cvent Appointments API to create or update the appointment,
    // then write the returned appointment ID to cventAppointmentId below.
    // If the meeting already has a cventAppointmentId, this is an update (re-push).
    await db
        .update(scheduledMeetings)
        .set({
            cventAppointmentId: `stub-${params.id}-${Date.now()}`,
            lastPushedAt: new Date(),
        })
        .where(eq(scheduledMeetings.id, params.id));
    revalidatePath("/admin/meetings", "layout");
}

/**
 * Pushes all un-synced portal meetings for a single sponsor. Covers both
 * not-yet-pushed meetings and meetings edited since their last push.
 * Like pushMeeting, this writes stub Cvent IDs — replace with real API
 * calls when the Cvent integration is wired up.
 *
 * @param {{ sponsorId: string; eventCode: string }} params
 * @returns {Promise<{ pushed: number }>} Count of meetings updated.
 */
export async function pushAllForSponsor(params: {
    sponsorId: string;
    eventCode: string;
}): Promise<{ pushed: number }> {
    const rows = await db
        .select({ id: scheduledMeetings.id })
        .from(scheduledMeetings)
        .where(
            and(
                eq(scheduledMeetings.eventCode, params.eventCode),
                eq(scheduledMeetings.source, "portal"),
                or(
                    eq(scheduledMeetings.attendeeA, params.sponsorId),
                    eq(scheduledMeetings.attendeeB, params.sponsorId),
                ),
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

    const now = new Date();
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

    revalidatePath("/admin/meetings", "layout");
    return { pushed: rows.length };
}

/** One selectable delegate in the create meeting modal. */
export type DelegateOption = {
    salesforceId: string;
    name: string;
    company: string;
};

/**
 * Returns all delegates for an event, sorted by name. Used to populate the
 * delegate picker in the create meeting modal.
 *
 * @param {{ eventCode: string }} params
 * @returns {Promise<DelegateOption[]>}
 */
export async function listDelegates(params: {
    eventCode: string;
}): Promise<DelegateOption[]> {
    const attendees = await loadAttendees(false, params.eventCode);
    return attendees
        .filter((a) => a.role === "delegate" && a.salesforceId)
        .map((a) => ({
            salesforceId: a.salesforceId,
            name: a.name,
            company: a.company,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Returns mutually available slot pairs for a new sponsor-delegate meeting.
 * Slots already taken by either attendee's existing meetings are excluded.
 * slotIdA belongs to the sponsor, slotIdB to the delegate.
 *
 * @param {{ sponsorId: string; delegateId: string; eventCode: string }} params
 * @returns {Promise<SlotOption[]>}
 */
export async function getNewMeetingSlots(params: {
    sponsorId: string;
    delegateId: string;
    eventCode: string;
}): Promise<SlotOption[]> {
    const [allMeetings, attendees] = await Promise.all([
        db
            .select()
            .from(scheduledMeetings)
            .where(eq(scheduledMeetings.eventCode, params.eventCode)),
        loadAttendees(false, params.eventCode),
    ]);

    const sponsor = attendees.find((a) => a.salesforceId === params.sponsorId);
    const delegate = attendees.find((a) => a.salesforceId === params.delegateId);
    if (!sponsor || !delegate) return [];

    const blockedSponsor = new Set<string>();
    const blockedDelegate = new Set<string>();
    for (const m of allMeetings) {
        if (m.attendeeA === params.sponsorId) blockedSponsor.add(m.slotIdA);
        if (m.attendeeB === params.sponsorId) blockedSponsor.add(m.slotIdB);
        if (m.attendeeA === params.delegateId) blockedDelegate.add(m.slotIdA);
        if (m.attendeeB === params.delegateId) blockedDelegate.add(m.slotIdB);
    }

    const options: SlotOption[] = [];
    for (const sa of sponsor.scheduling.slots) {
        if (sa.status !== "available" || blockedSponsor.has(sa.slotId)) continue;
        for (const sb of delegate.scheduling.slots) {
            if (sb.status !== "available" || blockedDelegate.has(sb.slotId)) continue;
            if (sa.day === sb.day && sa.startTime === sb.startTime) {
                options.push({
                    slotIdA: sa.slotId,
                    slotIdB: sb.slotId,
                    day: sa.day,
                    startTime: sa.startTime,
                    endTime: sa.endTime,
                });
            }
        }
    }

    return options.sort((a, b) => a.day - b.day || a.startTime.localeCompare(b.startTime));
}

/**
 * Inserts an admin-created meeting. The sponsor becomes attendeeA and the
 * delegate attendeeB. matchKind is always "admin". The meeting ID is a UUID
 * so it doesn't collide with engine-generated "mtg-NNN" ids.
 *
 * @param {{ eventCode: string; sponsorId: string; delegateId: string; slotIdA: string; slotIdB: string; day: 1 | 2; startTime: string; endTime: string; location: string | null }} params
 */
export async function createMeeting(params: {
    eventCode: string;
    sponsorId: string;
    delegateId: string;
    slotIdA: string;
    slotIdB: string;
    day: 1 | 2;
    startTime: string;
    endTime: string;
    location: string | null;
}): Promise<void> {
    const { randomUUID } = await import("crypto");
    await db.insert(scheduledMeetings).values({
        id: randomUUID(),
        eventCode: params.eventCode,
        attendeeA: params.sponsorId,
        attendeeB: params.delegateId,
        day: params.day,
        slotIdA: params.slotIdA,
        slotIdB: params.slotIdB,
        passNumber: 0,
        mutual: false,
        matchKind: "admin",
        rank: null,
        source: "portal",
        location: params.location?.trim() || null,
        startTime: params.startTime,
        endTime: params.endTime,
        cventAppointmentId: null,
        lastModifiedAt: null,
        lastPushedAt: null,
    });
    revalidatePath("/admin/meetings", "layout");
}
