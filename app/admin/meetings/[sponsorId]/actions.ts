"use server";

import { and, eq, gt, isNull, isNotNull, ne, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import {
    meetingRequests,
    scheduledMeetings,
    type ScheduledMeetingRow,
} from "@/lib/db/schema";
import { loadAttendees } from "@/lib/attendees/loader";
import { loadEventScheduleData } from "@/lib/cvent/mapper";
import { pushMeetingRows } from "@/lib/cvent/push";
import { contractedMeetings } from "@/lib/attendees/caps";
import type { MeetingMatchKind, MeetingSource } from "@/lib/db/schema";
import type { SponsorDetail, Timeslot, Location } from "@/types";
import type { PushResult, PushSummary } from "@/lib/cvent/push";

// Re-exported so client components (MeetingDetail) can type the push result
// without importing the server-only push module directly.
export type { PushResult, PushSummary };

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
    timeslotId: string;
    locationId: string | null;
    /** Resolved from the event's Cvent timeslot at read time. Null if the timeslot is unknown. */
    startTime: string | null;
    /** Resolved from the event's Cvent timeslot at read time. Null if the timeslot is unknown. */
    endTime: string | null;
    /** Resolved location name from the event's Cvent locations at read time. Null if unassigned/unknown. */
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
    if (m.lastModifiedAt && m.lastPushedAt && m.lastModifiedAt > m.lastPushedAt)
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
    const [attendees, meetingRows, requestRows, scheduleData] =
        await Promise.all([
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
            loadEventScheduleData(params.eventCode),
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
            // Resolve display values from the event's Cvent timeslots/locations.
            const timeslot = scheduleData.timeslotById.get(m.timeslotId);
            const location = m.locationId
                ? scheduleData.locationById.get(m.locationId)
                : undefined;
            return {
                id: m.id,
                delegateSalesforceId: delegateId,
                delegateName: delegate?.name ?? delegateId,
                delegateCompany: delegate?.company ?? "",
                matchKind: m.matchKind as MeetingMatchKind,
                rank: m.rank,
                timeslotId: m.timeslotId,
                locationId: m.locationId,
                startTime: timeslot?.startTime ?? null,
                endTime: timeslot?.endTime ?? null,
                location: location?.name ?? null,
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
            sponsorTier:
                sponsor.sponsorTier === "diamond" ? "diamond" : "standard",
            contracted,
            bonus,
            requestCount: requestRows.length,
            scheduledCount: meetingRows.length,
        },
        meetings,
    };
}

/** One option in the timeslot picker inside the edit/create meeting modals. */
export type SlotOption = {
    timeslotId: string;
    day: 1 | 2;
    startTime: string;
    endTime: string;
    /** The timeslot's native Cvent location, used as the default when booking. */
    locationId: string | null;
    locationName: string | null;
};

/** One option in the location picker. */
export type LocationOption = {
    id: string;
    name: string;
};

/**
 * Builds the set of timeslot ids an attendee is already booked into, from a list
 * of meetings (excluding the meeting being edited, if any).
 */
function bookedTimeslotIds(
    meetings: { attendeeA: string; attendeeB: string; timeslotId: string }[],
    attendeeId: string,
): Set<string> {
    const booked = new Set<string>();
    for (const m of meetings) {
        if (m.attendeeA === attendeeId || m.attendeeB === attendeeId) {
            booked.add(m.timeslotId);
        }
    }
    return booked;
}

/**
 * Builds the list of timeslot options available to BOTH attendees: timeslots
 * neither attendee is already booked into. (Capacity is enforced by the engine;
 * the admin picker keeps it simple by treating a timeslot as taken once either
 * attendee holds it.) Sorted by day then start time.
 */
function buildSlotOptions(
    timeslots: Timeslot[],
    locationById: Map<string, Location>,
    bookedA: Set<string>,
    bookedB: Set<string>,
): SlotOption[] {
    return timeslots
        .filter(
            (t) =>
                (t.day === 1 || t.day === 2) &&
                !bookedA.has(t.id) &&
                !bookedB.has(t.id),
        )
        .map((t) => ({
            timeslotId: t.id,
            day: t.day,
            startTime: t.startTime,
            endTime: t.endTime,
            locationId: t.locationId,
            locationName: t.locationId
                ? (locationById.get(t.locationId)?.name ?? null)
                : null,
        }))
        .sort(
            (a, b) => a.day - b.day || a.startTime.localeCompare(b.startTime),
        );
}

/** Maps the event's locations into picker options, sorted by name. */
function toLocationOptions(locations: Location[]): LocationOption[] {
    return locations
        .map((l) => ({ id: l.id, name: l.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Returns the available timeslot options for a meeting edit, the meeting's
 * current assignment, and the event's location options. Used to populate the
 * dropdowns in the edit modal.
 *
 * Timeslots already taken by other meetings for either attendee are excluded.
 * The current meeting's own timeslot is always included so the admin can save
 * without changing the time.
 *
 * @param {{ meetingId: string; eventCode: string }} params
 * @returns {Promise<{ current: SlotOption | null; options: SlotOption[]; locations: LocationOption[] }>}
 */
export async function getSlotOptions(params: {
    meetingId: string;
    eventCode: string;
}): Promise<{
    current: SlotOption | null;
    options: SlotOption[];
    locations: LocationOption[];
}> {
    const [meetingRows, otherMeetings, scheduleData] = await Promise.all([
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
        loadEventScheduleData(params.eventCode),
    ]);

    const meeting = meetingRows[0];
    if (!meeting) return { current: null, options: [], locations: [] };

    const { timeslots, locations, timeslotById, locationById } = scheduleData;
    const locationOptions = toLocationOptions(locations);

    const bookedA = bookedTimeslotIds(otherMeetings, meeting.attendeeA);
    const bookedB = bookedTimeslotIds(otherMeetings, meeting.attendeeB);
    const options = buildSlotOptions(timeslots, locationById, bookedA, bookedB);

    // The current timeslot, resolved for display. Always included so the admin
    // can save without changing the time even if it's otherwise filtered out.
    const currentTs = timeslotById.get(meeting.timeslotId);
    const current: SlotOption = {
        timeslotId: meeting.timeslotId,
        day: currentTs?.day ?? (meeting.day as 1 | 2),
        startTime: currentTs?.startTime ?? "",
        endTime: currentTs?.endTime ?? "",
        locationId: meeting.locationId,
        locationName: meeting.locationId
            ? (locationById.get(meeting.locationId)?.name ?? null)
            : null,
    };

    if (!options.some((o) => o.timeslotId === current.timeslotId)) {
        options.unshift(current);
    }

    return { current, options, locations: locationOptions };
}

/**
 * Updates a portal meeting's timeslot and location assignment, recording the
 * edit time for sync status tracking. `day` comes from the chosen timeslot's
 * SlotOption so the stored day stays consistent with the timeslot.
 *
 * @param {{ id: string; timeslotId: string; day: 1 | 2; locationId: string | null }} params
 */
export async function editMeeting(params: {
    id: string;
    timeslotId: string;
    day: 1 | 2;
    locationId: string | null;
}): Promise<void> {
    await db
        .update(scheduledMeetings)
        .set({
            timeslotId: params.timeslotId,
            day: params.day,
            locationId: params.locationId,
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
 * Pushes a single portal meeting to Cvent (create, or update if already synced)
 * and returns the structured result so the UI can report success/failure.
 *
 * @param {{ id: string; eventCode: string }} params
 * @returns {Promise<PushSummary>} The push outcome (a single-meeting summary).
 */
export async function pushMeeting(params: {
    id: string;
    eventCode: string;
}): Promise<PushSummary> {
    const rows = await db
        .select()
        .from(scheduledMeetings)
        .where(
            and(
                eq(scheduledMeetings.id, params.id),
                eq(scheduledMeetings.source, "portal"),
            ),
        );

    const summary = await pushMeetingRows(params.eventCode, rows);
    revalidatePath("/admin/meetings", "layout");
    return summary;
}

/**
 * Pushes all un-synced portal meetings for a single sponsor to Cvent. Covers
 * both not-yet-pushed meetings (create) and meetings edited since their last
 * push (update). Returns the structured result so the UI can report how many
 * succeeded and detail any failures.
 *
 * @param {{ sponsorId: string; eventCode: string }} params
 * @returns {Promise<PushSummary>} Aggregate counts plus per-meeting results.
 */
export async function pushAllForSponsor(params: {
    sponsorId: string;
    eventCode: string;
}): Promise<PushSummary> {
    const rows = await db
        .select()
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
                        gt(
                            scheduledMeetings.lastModifiedAt,
                            scheduledMeetings.lastPushedAt,
                        ),
                    ),
                ),
            ),
        );

    const summary = await pushMeetingRows(params.eventCode, rows);
    revalidatePath("/admin/meetings", "layout");
    return summary;
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
 * Returns the available timeslot options for a new sponsor-delegate meeting,
 * plus the event's location options. Timeslots already taken by either
 * attendee's existing meetings are excluded.
 *
 * @param {{ sponsorId: string; delegateId: string; eventCode: string }} params
 * @returns {Promise<{ options: SlotOption[]; locations: LocationOption[] }>}
 */
export async function getNewMeetingSlots(params: {
    sponsorId: string;
    delegateId: string;
    eventCode: string;
}): Promise<{ options: SlotOption[]; locations: LocationOption[] }> {
    const [allMeetings, scheduleData] = await Promise.all([
        db
            .select()
            .from(scheduledMeetings)
            .where(eq(scheduledMeetings.eventCode, params.eventCode)),
        loadEventScheduleData(params.eventCode),
    ]);

    const { timeslots, locations, locationById } = scheduleData;
    const bookedSponsor = bookedTimeslotIds(allMeetings, params.sponsorId);
    const bookedDelegate = bookedTimeslotIds(allMeetings, params.delegateId);

    return {
        options: buildSlotOptions(
            timeslots,
            locationById,
            bookedSponsor,
            bookedDelegate,
        ),
        locations: toLocationOptions(locations),
    };
}

/**
 * Inserts an admin-created meeting. The sponsor becomes attendeeA and the
 * delegate attendeeB. matchKind is always "admin". The meeting ID is a UUID
 * so it doesn't collide with engine-generated "mtg-NNN" ids.
 *
 * @param {{ eventCode: string; sponsorId: string; delegateId: string; timeslotId: string; day: 1 | 2; locationId: string | null }} params
 */
export async function createMeeting(params: {
    eventCode: string;
    sponsorId: string;
    delegateId: string;
    timeslotId: string;
    day: 1 | 2;
    locationId: string | null;
}): Promise<void> {
    const { randomUUID } = await import("crypto");
    await db.insert(scheduledMeetings).values({
        id: randomUUID(),
        eventCode: params.eventCode,
        attendeeA: params.sponsorId,
        attendeeB: params.delegateId,
        day: params.day,
        timeslotId: params.timeslotId,
        passNumber: 0,
        mutual: false,
        matchKind: "admin",
        rank: null,
        source: "portal",
        locationId: params.locationId,
        cventAppointmentId: null,
        lastModifiedAt: null,
        lastPushedAt: null,
    });
    revalidatePath("/admin/meetings", "layout");
}
