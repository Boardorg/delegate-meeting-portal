import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { scheduledMeetings, type ScheduledMeetingRow } from "@/lib/db/schema";
import { loadEventScheduleData } from "@/lib/cvent/mapper";
import { loadAttendees } from "@/lib/attendees/loader";
import { createAppointment, updateAppointment } from "@/lib/cvent/client";

// ---------------------------------------------------------------------------
// Shared push-to-Cvent logic
//
// One place that turns scheduled_meetings rows into Cvent appointments and
// reports, per meeting, whether it succeeded and why not. Used by both the
// event-wide and per-sponsor push actions so their behavior stays identical
// and callers get structured results to show in the UI.
// ---------------------------------------------------------------------------

/** Result of pushing a single meeting to Cvent. */
export type PushResult = {
    /** The scheduled meeting id. */
    meetingId: string;
    /** Human label for the meeting, e.g. "Acme Sponsor & Jane Delegate". */
    label: string;
    /** Whether the Cvent create/update succeeded. */
    ok: boolean;
    /** The Cvent appointment id on success. */
    cventAppointmentId?: string | null;
    /** The error message on failure (from Cvent or validation). */
    error?: string;
};

/** Aggregate result of a push-all operation. */
export type PushSummary = {
    /** Number of meetings attempted. */
    total: number;
    /** Number that succeeded. */
    pushed: number;
    /** Number that failed. */
    failed: number;
    /** Per-meeting outcomes, in input order. */
    results: PushResult[];
};

/**
 * Pushes a set of scheduled-meeting rows to Cvent: creates a new appointment
 * for rows not yet synced, updates the existing appointment for rows edited
 * since their last push. Resolves each meeting's time from its Cvent timeslot
 * and maps participants from Salesforce ids to Cvent contact ids. On success it
 * writes back the appointment id + push time; failures are captured per row so
 * one bad meeting doesn't abort the batch.
 *
 * @param {string} eventCode - The event the meetings belong to.
 * @param {ScheduledMeetingRow[]} rows - The meeting rows to push.
 * @returns {Promise<PushSummary>} Aggregate counts plus per-meeting results.
 */
export async function pushMeetingRows(
    eventCode: string,
    rows: ScheduledMeetingRow[],
): Promise<PushSummary> {
    if (rows.length === 0) {
        return { total: 0, pushed: 0, failed: 0, results: [] };
    }

    // Resolve timeslot times and attendee Cvent contact ids for the whole batch.
    const [scheduleData, attendees] = await Promise.all([
        loadEventScheduleData(eventCode),
        loadAttendees(false, eventCode),
    ]);
    const attendeeById = new Map(attendees.map((a) => [a.salesforceId, a]));

    const results: PushResult[] = [];
    for (const row of rows) {
        // attendeeA is the requester (the party whose request produced the
        // meeting) and hosts the Cvent appointment; attendeeB is the target.
        const requester = attendeeById.get(row.attendeeA);
        const target = attendeeById.get(row.attendeeB);
        const label = `${requester?.name ?? row.attendeeA} & ${target?.name ?? row.attendeeB}`;

        // A meeting can't be pushed without a resolvable time block.
        const timeslot = scheduleData.timeslotById.get(row.timeslotId);
        if (!timeslot) {
            results.push({
                meetingId: row.id,
                label,
                ok: false,
                error: `No Cvent timeslot found for id ${row.timeslotId}`,
            });
            continue;
        }

        // The requester hosts the appointment, so a Cvent contact id is required.
        const hostContactId = requester?.cventContactId;
        if (!hostContactId) {
            results.push({
                meetingId: row.id,
                label,
                ok: false,
                error: `Requester ${requester?.name ?? row.attendeeA} has no Cvent contact id to host the appointment`,
            });
            continue;
        }

        // Attendees are the non-host participant(s); the target's contact id
        // when known.
        const attendeeContactIds = target?.cventContactId
            ? [target.cventContactId]
            : [];

        const input = {
            subject: label,
            startTime: new Date(timeslot.startTime),
            endTime: new Date(timeslot.endTime),
            hostContactId,
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

            results.push({ meetingId: row.id, label, ok: true, cventAppointmentId });
        } catch (err) {
            results.push({
                meetingId: row.id,
                label,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    const pushed = results.filter((r) => r.ok).length;
    return { total: results.length, pushed, failed: results.length - pushed, results };
}
