"use server";

import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import {
    meetingRequests,
    scheduledMeetings,
    type ScheduledMeetingRow,
} from "@/lib/db/schema";
import { loadAttendees } from "@/lib/attendees/loader";
import { sponsorCompaniesByAccountId } from "@/lib/attendees/companies";
import { loadEventScheduleData } from "@/lib/cvent/mapper";
import { pushMeetingRows, needsSync } from "@/lib/cvent/push";
import { buildSyncReport, type SyncReport } from "@/lib/cvent/syncReport";
import { cancelAppointment, getAppointmentsByEvent } from "@/lib/cvent/client";
import { contractedMeetings } from "@/lib/attendees/caps";
import type { MeetingMatchKind, MeetingSource } from "@/lib/db/schema";
import {
    bookedIntervals,
    buildSlotOptions,
    slotOptionFromTimeslot,
    sortSlotOptions,
    type SlotOption,
} from "@/lib/scheduling/slotOptions";
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
    /** True when the delegate cancelled their Cvent registration. Push skips these meetings. */
    delegateCancelled: boolean;
    matchKind: MeetingMatchKind;
    /**
     * Whether both parties asked for this pairing — the sponsor through the
     * portal and the delegate on the event's intake form. Read straight off the
     * stored row rather than inferred from `matchKind`, so the highlight tracks
     * what the engine actually recorded. Always false for admin-created rows.
     */
    mutual: boolean;
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
 * @returns {Promise<{ sponsor: SponsorDetail; meetings: MeetingRow[]; timezone: string } | null>}
 */
export async function getMeetingDetail(params: {
    sponsorId: string;
    eventCode: string;
}): Promise<{
    sponsor: SponsorDetail;
    meetings: MeetingRow[];
    timezone: string;
} | null> {
    const [attendees, meetingRows, requestRows, scheduleData, appointments] =
        await Promise.all([
            loadAttendees(false, params.eventCode),
            db
                .select()
                .from(scheduledMeetings)
                .where(
                    and(
                        eq(scheduledMeetings.eventCode, params.eventCode),
                        // The company is always the A side of a sponsor meeting.
                        eq(scheduledMeetings.attendeeA, params.sponsorId),
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
            getAppointmentsByEvent(params.eventCode),
        ]);

    // A pushed meeting's Cvent timeslot drops out of listAvailableTimes once booked.
    // Look synced meetings up by their Cvent appointment instead, which keeps the real time and location.
    const appointmentById = new Map(appointments.map((a) => [a.id, a]));

    // sponsorId is a company Account id; resolve the company (all its reps).
    const company = sponsorCompaniesByAccountId(attendees).get(
        params.sponsorId,
    );
    if (!company) return null;
    // A representative rep supplies the base Attendee fields for SponsorDetail.
    const rep = company.reps[0];

    const attendeeMap = new Map(attendees.map((a) => [a.salesforceId, a]));

    const contracted = contractedMeetings(company.tier);
    const bonus = 0;

    const meetings: MeetingRow[] = meetingRows
        .map((m) => {
            // The company is always attendeeA, so the delegate is attendeeB.
            const delegateId = m.attendeeB;
            const delegate = attendeeMap.get(delegateId);
            // Once pushed, prefer the Cvent appointment itself for time/location
            // (see appointmentById above). Otherwise resolve from the event's
            // Cvent timeslots/locations, same as before.
            const appointment = m.cventAppointmentId
                ? appointmentById.get(m.cventAppointmentId)
                : undefined;
            const timeslot = scheduleData.timeslotById.get(m.timeslotId);
            const location = m.locationId
                ? scheduleData.locationById.get(m.locationId)
                : undefined;
            return {
                id: m.id,
                delegateSalesforceId: delegateId,
                delegateName: delegate?.name ?? delegateId,
                delegateCompany: delegate?.company ?? "",
                delegateCancelled: !!delegate?.cventCancelled,
                matchKind: m.matchKind as MeetingMatchKind,
                mutual: m.mutual,
                rank: m.rank,
                timeslotId: m.timeslotId,
                locationId: m.locationId,
                startTime:
                    appointment?.startTime.toISOString() ??
                    timeslot?.startTime ??
                    null,
                endTime:
                    appointment?.endTime.toISOString() ??
                    timeslot?.endTime ??
                    null,
                location: appointment?.locationName ?? location?.name ?? null,
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
            // Base Attendee fields come from a representative rep; company-level
            // fields (name/company/tier/accountId/reps) are overridden below.
            ...rep,
            name: company.name,
            company: company.name,
            accountId: company.accountId,
            reps: company.reps,
            sponsorTier: company.tier === "diamond" ? "diamond" : "standard",
            contracted,
            bonus,
            requestCount: requestRows.length,
            scheduledCount: meetingRows.length,
        },
        meetings,
        timezone: scheduleData.timezone,
    };
}

/**
 * Returns the available timeslot options for a meeting edit and the meeting's
 * current assignment. Used to populate the Time Slot dropdown in the edit
 * modal — each option carries its own native location, so there's no separate
 * location picker to keep in sync.
 *
 * Timeslots whose time overlaps another meeting for either attendee are
 * excluded — including a different Cvent location at the same time — so an edit
 * can't move the meeting into a slot that double-books the requester or target.
 * The current meeting's own timeslot is always included so the admin can save
 * without changing the time.
 *
 * @param {{ meetingId: string; eventCode: string }} params
 * @returns {Promise<{ current: SlotOption | null; options: SlotOption[] }>}
 */
export async function getSlotOptions(params: {
    meetingId: string;
    eventCode: string;
}): Promise<{
    current: SlotOption | null;
    options: SlotOption[];
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
    if (!meeting) return { current: null, options: [] };

    const { timeslots, timeslotById, locationById } = scheduleData;

    const bookedA = bookedIntervals(
        otherMeetings,
        meeting.attendeeA,
        timeslotById,
    );
    const bookedB = bookedIntervals(
        otherMeetings,
        meeting.attendeeB,
        timeslotById,
    );
    const options = buildSlotOptions(timeslots, locationById, bookedA, bookedB);

    // The current timeslot, resolved for display. Always included so the admin
    // can save without changing the time even if it's otherwise filtered out.
    // Its appointment type is unknown when Cvent no longer lists the slot.
    const currentTs = timeslotById.get(meeting.timeslotId);
    const currentType = currentTs
        ? slotOptionFromTimeslot(currentTs, locationById)
        : null;
    const current: SlotOption = {
        timeslotId: meeting.timeslotId,
        day: currentTs?.day ?? (meeting.day as 1 | 2),
        startTime: currentTs?.startTime ?? "",
        endTime: currentTs?.endTime ?? "",
        locationId: meeting.locationId,
        locationName: meeting.locationId
            ? (locationById.get(meeting.locationId)?.name ?? null)
            : null,
        appointmentTypeId: currentType?.appointmentTypeId ?? null,
        appointmentTypeName: currentType?.appointmentTypeName ?? null,
        kind: currentType?.kind ?? null,
    };

    // Re-sort after adding the current slot, so it lands in its type's group.
    if (!options.some((o) => o.timeslotId === current.timeslotId)) {
        return { current, options: sortSlotOptions([...options, current]) };
    }

    return { current, options };
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
 * If the meeting was already pushed to Cvent, its appointment is cancelled
 * there first — otherwise Cvent is left with an orphaned appointment holding
 * this meeting's id as its `code`, and since Cvent never frees a `code` even
 * after cancellation, that id could never be reused by a future scheduler run
 * (it would fail to push with APPT_CODE_ALREADY_EXISTS). If the cancel call
 * fails, the DB row is left in place rather than deleted, so the meeting
 * doesn't silently become an untracked orphan.
 *
 * @param {{ id: string }} params
 */
export async function removeMeeting(params: { id: string }): Promise<void> {
    const [row] = await db
        .select({
            eventCode: scheduledMeetings.eventCode,
            cventAppointmentId: scheduledMeetings.cventAppointmentId,
        })
        .from(scheduledMeetings)
        .where(
            and(
                eq(scheduledMeetings.id, params.id),
                eq(scheduledMeetings.source, "portal"),
            ),
        )
        .limit(1);

    if (row?.cventAppointmentId) {
        await cancelAppointment(row.eventCode, row.cventAppointmentId);
    }

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
 * and returns a sync report so the UI can render the same result panel as the
 * event-wide push. The meeting is always attempted, so "already synced" is 0.
 *
 * @param {{ id: string; eventCode: string }} params
 * @returns {Promise<SyncReport>} The push outcome as a (single-meeting) report.
 */
export async function pushMeeting(params: {
    id: string;
    eventCode: string;
}): Promise<SyncReport> {
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

    return buildSyncReport({
        eventCode: params.eventCode,
        generatedAt: new Date().toISOString(),
        totalPortalMeetings: rows.length,
        alreadySynced: 0,
        results: summary.results,
    });
}

/**
 * Pushes all un-synced portal meetings for a single sponsor to Cvent. Covers
 * both not-yet-pushed meetings (create) and meetings edited since their last
 * push (update), and returns a sync report scoped to that sponsor — so the UI
 * can render the same result panel as the event-wide push, including how many
 * of the sponsor's meetings were already synced.
 *
 * @param {{ sponsorId: string; eventCode: string }} params
 * @returns {Promise<SyncReport>} A DB-friendly summary of the sponsor's push.
 */
export async function pushAllForSponsor(params: {
    sponsorId: string;
    eventCode: string;
}): Promise<SyncReport> {
    // Load every portal meeting for this sponsor, then partition in memory so
    // the untouched (already-synced) ones are still counted in the report.
    const sponsorRows = await db
        .select()
        .from(scheduledMeetings)
        .where(
            and(
                eq(scheduledMeetings.eventCode, params.eventCode),
                eq(scheduledMeetings.source, "portal"),
                // The company (account id) is always the A side of its meetings.
                eq(scheduledMeetings.attendeeA, params.sponsorId),
            ),
        );

    const toPush = sponsorRows.filter(needsSync);
    const alreadySynced = sponsorRows.length - toPush.length;

    const summary = await pushMeetingRows(params.eventCode, toPush);
    revalidatePath("/admin/meetings", "layout");

    return buildSyncReport({
        eventCode: params.eventCode,
        generatedAt: new Date().toISOString(),
        totalPortalMeetings: sponsorRows.length,
        alreadySynced,
        results: summary.results,
    });
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
 * Returns the available timeslot options for a new sponsor-delegate meeting.
 * Timeslots already taken by either attendee's existing meetings are
 * excluded. Each option carries its own native location — there's no separate
 * location picker to keep in sync.
 *
 * @param {{ sponsorId: string; delegateId: string; eventCode: string }} params
 * @returns {Promise<{ options: SlotOption[] }>}
 */
export async function getNewMeetingSlots(params: {
    sponsorId: string;
    delegateId: string;
    eventCode: string;
}): Promise<{ options: SlotOption[] }> {
    const [allMeetings, scheduleData] = await Promise.all([
        db
            .select()
            .from(scheduledMeetings)
            .where(eq(scheduledMeetings.eventCode, params.eventCode)),
        loadEventScheduleData(params.eventCode),
    ]);

    const { timeslots, timeslotById, locationById } = scheduleData;
    const bookedSponsor = bookedIntervals(
        allMeetings,
        params.sponsorId,
        timeslotById,
    );
    const bookedDelegate = bookedIntervals(
        allMeetings,
        params.delegateId,
        timeslotById,
    );

    return {
        options: buildSlotOptions(
            timeslots,
            locationById,
            bookedSponsor,
            bookedDelegate,
        ),
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
