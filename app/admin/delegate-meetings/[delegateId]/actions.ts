"use server";

import { and, eq, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { scheduledMeetings, type MeetingSource } from "@/lib/db/schema";
import { cancelAppointment } from "@/lib/cvent/client";
import { needsSync, pushDelegateMeetingRows } from "@/lib/cvent/push";
import {
    buildSyncReport,
    isAppointmentAlreadyGone,
    parseCventError,
    type SyncReport,
} from "@/lib/cvent/syncReport";
import { getSyncStatus, type SyncStatus } from "@/lib/cvent/syncStatus";
import { sponsorCompaniesByAccountId } from "@/lib/attendees/companies";
import { loadMatchingContext, type MatchingContext } from "@/lib/matching/data";
import { d2dExclusion, startMs, totalMeetingCap, type D2DExclusion } from "@/lib/matching/d2d";
import { buildAnswerScales } from "@/lib/matching/questions";
import { seatedDelegateIds } from "@/lib/matching/delegateMeetings";
import { explainMatch, scorePair } from "@/lib/matching/score";
import {
    bookedIntervals,
    buildSlotOptions,
    overlapsBooked,
    slotOptionFromTimeslot,
    sortSlotOptions,
    type BookedInterval,
    type SlotOption,
} from "@/lib/scheduling/slotOptions";

// ---------------------------------------------------------------------------
// Server actions for /admin/delegate-meetings/[delegateId], one delegate's meetings.
//
// They mirror the per-sponsor actions in app/admin/meetings/[sponsorId]/actions.ts.
// Admins can move a D2D meeting to another D2D slot, remove it, or push it.
// They can't pair two delegates by hand in this version.
// S2D meetings and appointments only in Cvent are shown read-only for context.
// ---------------------------------------------------------------------------

/** One row in a delegate's meeting table. */
export type DelegateMeetingRow = {
    id: string;
    /** D2D meetings can be changed here. S2D meetings are shown for context only. */
    kind: "d2d" | "s2d";
    /** The other delegate on a D2D meeting, or the sponsor company on an S2D meeting. */
    otherName: string;
    otherCompany: string;
    /** True when the other delegate isn't registered in Cvent, such as cancelled or never registered. */
    otherCancelled: boolean;
    /** True when this delegate hosts the D2D meeting in Cvent. Null for S2D and Cvent-only rows. */
    isHost: boolean | null;
    /** What the two share, for a D2D meeting. Empty otherwise. */
    shared: string;
    /** The pair's match score, for a portal D2D meeting. Null otherwise. */
    score: number | null;
    /** True when the score is below the event's minimum. */
    weak: boolean;
    timeslotId: string;
    startTime: string | null;
    endTime: string | null;
    location: string | null;
    syncStatus: SyncStatus;
    source: MeetingSource;
    /** True for S2D meetings and appointments only in Cvent. They can't be changed here. */
    readOnly: boolean;
};

/** One delegate's header details. */
export type DelegateDetail = {
    delegateId: string;
    name: string;
    title: string;
    company: string;
    s2dCount: number;
    d2dCount: number;
    /** The most D2D meetings they may have, their total cap minus their S2D meetings. */
    d2dCap: number;
    /** Why they can't be matched for D2D. Null when they can. */
    exclusion: D2DExclusion | null;
};

/** The result of a save or remove from the delegate page. */
export type DelegateMeetingResult = { ok: true } | { ok: false; error: string };

/**
 * Loads one delegate's details and meetings for an event.
 * Returns null when the id isn't a known delegate, which the page turns into a 404.
 *
 * @param {{ delegateId: string; eventCode: string }} params - The delegate and event.
 * @returns {Promise<{ delegate: DelegateDetail; meetings: DelegateMeetingRow[]; timezone: string } | null>}
 */
export async function getDelegateMeetingDetail(params: {
    delegateId: string;
    eventCode: string;
}): Promise<{ delegate: DelegateDetail; meetings: DelegateMeetingRow[]; timezone: string } | null> {
    const ctx = await loadMatchingContext(params.eventCode);
    const me = ctx.attendees.find((a) => a.salesforceId === params.delegateId && a.role === "delegate");
    if (!me) return null;

    const byId = new Map(ctx.attendees.map((a) => [a.salesforceId, a]));
    const companies = sponsorCompaniesByAccountId(ctx.attendees);
    const appointmentById = new Map((ctx.appointments ?? []).filter((a) => a.id).map((a) => [a.id!, a]));
    const scales = buildAnswerScales(ctx.attendees.filter((a) => a.role === "delegate").map((a) => a.profile));
    const { locationById } = ctx.scheduleData;
    const timeslotById = ctx.slotById;

    const meetings: DelegateMeetingRow[] = [];
    for (const r of ctx.rows) {
        const isD2D = r.kind === "delegate_delegate";
        const mine = isD2D ? r.attendeeA === me.salesforceId || r.attendeeB === me.salesforceId : r.attendeeB === me.salesforceId;
        if (!mine) continue;
        const ts = timeslotById.get(r.timeslotId);
        // A pushed meeting's slot can be missing from Cvent's list, so fall back to its appointment.
        const appt = r.cventAppointmentId ? appointmentById.get(r.cventAppointmentId) : undefined;
        const base = {
            id: r.id,
            timeslotId: r.timeslotId,
            startTime: ts?.startTime ?? appt?.startTime ?? null,
            endTime: ts?.endTime ?? null,
            location: (r.locationId ? locationById.get(r.locationId)?.name : undefined) ?? appt?.locationName ?? null,
            syncStatus: getSyncStatus(r),
            source: r.source as MeetingSource,
        };
        if (isD2D) {
            const other = byId.get(r.attendeeA === me.salesforceId ? r.attendeeB : r.attendeeA);
            const score = other ? scorePair(me.profile, other.profile, ctx.settings.d2d.questions, scales) : null;
            meetings.push({
                ...base,
                kind: "d2d",
                otherName: other?.name ?? (r.attendeeA === me.salesforceId ? r.attendeeB : r.attendeeA),
                otherCompany: other?.company ?? "",
                otherCancelled: !!other?.cventCancelled,
                isHost: r.attendeeA === me.salesforceId,
                shared: score ? explainMatch(score.shared) : "",
                score: score?.score ?? null,
                weak: !!score && score.score < ctx.settings.d2d.minScore,
                readOnly: false,
            });
        } else {
            const company = companies.get(r.attendeeA);
            meetings.push({
                ...base,
                kind: "s2d",
                otherName: company?.name ?? r.attendeeA,
                otherCompany: "Sponsor",
                otherCancelled: false,
                isHost: null,
                shared: "",
                score: null,
                weak: false,
                readOnly: true,
            });
        }
    }

    // Appointments only in Cvent that this delegate is in. They count, but can only be changed in Cvent.
    for (const c of ctx.cventOnly) {
        if (!c.delegateIds.includes(me.salesforceId)) continue;
        const others = c.appointment.participantContactIds
            .map((id) => ctx.attendees.find((a) => a.cventContactId === id))
            .filter((a): a is NonNullable<typeof a> => !!a && a.salesforceId !== me.salesforceId);
        meetings.push({
            id: `cvent-${c.appointment.id ?? c.appointment.startTime}`,
            kind: c.hasSponsor ? "s2d" : "d2d",
            otherName: others.map((a) => a.name).join(", ") || "No one the portal knows",
            otherCompany: [...new Set(others.map((a) => a.company))].join(", "),
            otherCancelled: false,
            isHost: null,
            shared: "",
            score: null,
            weak: false,
            timeslotId: "",
            startTime: c.appointment.startTime,
            endTime: null,
            location: c.appointment.locationName,
            syncStatus: "synced",
            source: "cvent",
            readOnly: true,
        });
    }

    meetings.sort((a, b) => {
        if (!a.startTime) return 1;
        if (!b.startTime) return -1;
        return startMs(a.startTime) - startMs(b.startTime);
    });

    const counts = ctx.counts.get(me.salesforceId) ?? { s2d: 0, d2d: 0 };
    return {
        delegate: {
            delegateId: me.salesforceId,
            name: me.name,
            title: me.title,
            company: me.company,
            s2dCount: counts.s2d,
            d2dCount: counts.d2d,
            d2dCap: Math.max(0, totalMeetingCap(counts.s2d, ctx.settings.d2d) - counts.s2d),
            exclusion:
                d2dExclusion(me) ??
                (seatedDelegateIds(ctx.seatRows).has(me.salesforceId) ? "seated_at_roundtable" : null),
        },
        meetings,
        timezone: ctx.scheduleData.timezone,
    };
}

/**
 * The times a party is busy, from portal meetings other than one, their roundtable seat, and Cvent appointments.
 * Cvent appointments carry no end time, so each blocks the instant it starts.
 *
 * @param {MatchingContext} ctx - The event's matching data.
 * @param {string} partyId - The delegate's Salesforce id.
 * @param {string} exceptMeetingId - The meeting being moved, which doesn't count.
 * @returns {BookedInterval[]} The busy spans.
 */
function busyIntervals(ctx: MatchingContext, partyId: string, exceptMeetingId: string): BookedInterval[] {
    const out = bookedIntervals(
        ctx.rows.filter((r) => r.id !== exceptMeetingId),
        partyId,
        ctx.slotById,
    );
    const me = ctx.attendees.find((a) => a.salesforceId === partyId);
    const moving = ctx.rows.find((r) => r.id === exceptMeetingId);
    for (const appt of ctx.appointments ?? []) {
        if (!me?.cventContactId || !appt.participantContactIds.includes(me.cventContactId)) continue;
        // The moving meeting's own appointment doesn't block it.
        if (moving?.cventAppointmentId && appt.id === moving.cventAppointmentId) continue;
        const ms = startMs(appt.startTime);
        out.push({ start: ms, end: ms + 1 });
    }
    // A roundtable seat is a meeting at the table's whole slot.
    const slotByTable = new Map(ctx.roundtableRows.map((r) => [r.id, r.timeslotId]));
    for (const seat of ctx.seatRows) {
        if (seat.delegateId !== partyId || seat.role !== "seated") continue;
        const ts = ctx.slotById.get(slotByTable.get(seat.roundtableId) ?? "");
        if (ts) out.push({ start: startMs(ts.startTime), end: startMs(ts.endTime) });
    }
    return out;
}

/**
 * Returns the D2D slots a meeting can move to, and its current slot.
 * Only delegate_delegate slots where both delegates are free are offered.
 * The current slot is always included so the admin can save without changing the time.
 *
 * @param {{ meetingId: string; eventCode: string }} params - The meeting and event.
 * @returns {Promise<{ current: SlotOption | null; options: SlotOption[] }>} The options.
 */
export async function getD2DSlotOptions(params: {
    meetingId: string;
    eventCode: string;
}): Promise<{ current: SlotOption | null; options: SlotOption[] }> {
    const ctx = await loadMatchingContext(params.eventCode);
    const meeting = ctx.rows.find((r) => r.id === params.meetingId && r.kind === "delegate_delegate");
    if (!meeting) return { current: null, options: [] };
    const { timeslots, locationById } = ctx.scheduleData;

    const options = buildSlotOptions(
        timeslots.filter((t) => t.kind === "delegate_delegate"),
        locationById,
        busyIntervals(ctx, meeting.attendeeA, meeting.id),
        busyIntervals(ctx, meeting.attendeeB, meeting.id),
    );
    const currentTs = ctx.slotById.get(meeting.timeslotId);
    const current = currentTs ? slotOptionFromTimeslot(currentTs, locationById) : null;
    if (current && !options.some((o) => o.timeslotId === current.timeslotId)) {
        return { current, options: sortSlotOptions([...options, current]) };
    }
    return { current, options };
}

/**
 * Moves a D2D meeting to another D2D slot, at that slot's location, and marks it modified.
 * The slot must be a delegate_delegate slot where both delegates are free.
 * Choosing the meeting's own slot succeeds without saving anything.
 *
 * @param {{ id: string; eventCode: string; timeslotId: string }} params - The meeting, event and new slot.
 * @returns {Promise<DelegateMeetingResult>} Success, or why nothing was saved.
 */
export async function moveD2DMeeting(params: {
    id: string;
    eventCode: string;
    timeslotId: string;
}): Promise<DelegateMeetingResult> {
    const ctx = await loadMatchingContext(params.eventCode);
    const meeting = ctx.rows.find(
        (r) => r.id === params.id && r.kind === "delegate_delegate" && r.source === "portal",
    );
    if (!meeting) return { ok: false, error: "Error: meeting not found" };
    // Keeping the meeting in its own slot changes nothing.
    // That slot can be missing from Cvent's list once it is booked, so this comes before the list check.
    // Saving it would also mark the meeting Modified for no change.
    if (params.timeslotId === meeting.timeslotId) return { ok: true };
    const slot = ctx.scheduleData.timeslotById.get(params.timeslotId);
    if (!slot) return { ok: false, error: "Error: that time slot isn't in Cvent any more" };
    if (slot.kind !== "delegate_delegate") {
        return { ok: false, error: "Error: D2D meetings can only use Delegate to Delegate slots" };
    }
    for (const party of [meeting.attendeeA, meeting.attendeeB]) {
        if (overlapsBooked(slot, busyIntervals(ctx, party, meeting.id))) {
            const name = ctx.attendees.find((a) => a.salesforceId === party)?.name ?? party;
            return { ok: false, error: `Error: ${name} already has a meeting at that time` };
        }
    }

    await db
        .update(scheduledMeetings)
        .set({
            timeslotId: slot.id,
            day: slot.day,
            locationId: slot.locationId,
            lastModifiedAt: new Date(),
        })
        .where(and(eq(scheduledMeetings.id, meeting.id), eq(scheduledMeetings.kind, "delegate_delegate")));
    revalidatePath("/admin/delegate-meetings", "layout");
    return { ok: true };
}

/**
 * Removes a D2D meeting.
 * A pushed meeting's Cvent appointment is cancelled first, with notifications suppressed when CVENT_SUPPRESS_NOTIFICATIONS is set.
 * When the cancel fails the meeting is kept, so Cvent isn't left with an appointment the portal forgot.
 * An appointment already gone in Cvent doesn't stop the removal.
 *
 * @param {{ id: string }} params - The meeting.
 * @returns {Promise<DelegateMeetingResult>} Success, or why nothing was removed.
 */
export async function removeD2DMeeting(params: { id: string }): Promise<DelegateMeetingResult> {
    const [row] = await db
        .select()
        .from(scheduledMeetings)
        .where(
            and(
                eq(scheduledMeetings.id, params.id),
                eq(scheduledMeetings.source, "portal"),
                eq(scheduledMeetings.kind, "delegate_delegate"),
            ),
        )
        .limit(1);
    if (!row) return { ok: false, error: "Error: meeting not found" };

    if (row.cventAppointmentId) {
        try {
            await cancelAppointment(row.eventCode, row.cventAppointmentId);
        } catch (err) {
            if (!isAppointmentAlreadyGone(err)) {
                const message =
                    parseCventError((err as { body?: string }).body).message ??
                    (err instanceof Error ? err.message : String(err));
                return { ok: false, error: `Error: Cvent didn't cancel the appointment, so the meeting was kept. ${message}` };
            }
        }
    }

    await db.delete(scheduledMeetings).where(eq(scheduledMeetings.id, row.id));
    revalidatePath("/admin/delegate-meetings", "layout");
    return { ok: true };
}

/**
 * Pushes one D2D meeting to Cvent and returns a one-meeting sync report.
 *
 * @param {{ id: string; eventCode: string }} params - The meeting and event.
 * @returns {Promise<SyncReport>} The push report.
 */
export async function pushD2DMeeting(params: { id: string; eventCode: string }): Promise<SyncReport> {
    const rows = await db
        .select()
        .from(scheduledMeetings)
        .where(
            and(
                eq(scheduledMeetings.id, params.id),
                eq(scheduledMeetings.source, "portal"),
                eq(scheduledMeetings.kind, "delegate_delegate"),
            ),
        );
    const summary = await pushDelegateMeetingRows(params.eventCode, rows);
    revalidatePath("/admin/delegate-meetings", "layout");
    return buildSyncReport({
        eventCode: params.eventCode,
        generatedAt: new Date().toISOString(),
        totalPortalMeetings: rows.length,
        alreadySynced: 0,
        results: summary.results,
    });
}

/**
 * Pushes every D2D meeting of one delegate that is not pushed or was changed since its last push.
 *
 * @param {{ delegateId: string; eventCode: string }} params - The delegate and event.
 * @returns {Promise<SyncReport>} The push report.
 */
export async function pushAllForDelegate(params: { delegateId: string; eventCode: string }): Promise<SyncReport> {
    const rows = await db
        .select()
        .from(scheduledMeetings)
        .where(
            and(
                eq(scheduledMeetings.eventCode, params.eventCode),
                eq(scheduledMeetings.source, "portal"),
                eq(scheduledMeetings.kind, "delegate_delegate"),
                or(
                    eq(scheduledMeetings.attendeeA, params.delegateId),
                    eq(scheduledMeetings.attendeeB, params.delegateId),
                ),
            ),
        );
    const toPush = rows.filter(needsSync);
    const summary = await pushDelegateMeetingRows(params.eventCode, toPush);
    revalidatePath("/admin/delegate-meetings", "layout");
    return buildSyncReport({
        eventCode: params.eventCode,
        generatedAt: new Date().toISOString(),
        totalPortalMeetings: rows.length,
        alreadySynced: rows.length - toPush.length,
        results: summary.results,
    });
}
