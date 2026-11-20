import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { scheduledMeetings, type ScheduledMeetingRow } from "@/lib/db/schema";
import { cancelAppointment } from "@/lib/cvent/client";
import {
    isAppointmentAlreadyGone,
    parseCventError,
} from "@/lib/cvent/syncReport";

// ---------------------------------------------------------------------------
// Shared unpush step for "Unpush All Synced".
//
// Moved out of app/admin/meetings/actions.ts so the sponsor and delegate meeting pages
// cancel and unlink meetings the same way.
// Cancelling goes through cancelAppointment, which suppresses Cvent's emails when CVENT_SUPPRESS_NOTIFICATIONS is set.
// Roundtables unpush through unpushAppointments too, with their own unlink step.
// ---------------------------------------------------------------------------

/** One meeting's note or failure in an unpush. */
export type UnpushDetail = { meetingId: string; label: string; detail: string };

/** What unpushing a batch of meetings did. */
export type UnpushOutcome = {
    /** How many were cancelled in Cvent and unlinked in the DB. */
    unpushed: number;
    /** How many were already gone in Cvent, and unlinked anyway. */
    alreadyGone: number;
    /** Per-meeting failure detail. These stay synced in the DB. */
    failures: UnpushDetail[];
    /** Per-meeting notes for the already-gone meetings. */
    notes: UnpushDetail[];
};

/** The fields of a synced row that unpush reads. */
export type UnpushRow = { id: string; cventAppointmentId: string | null };

/**
 * Cancels the Cvent appointment behind each synced meeting, then clears that meeting's cventAppointmentId.
 *
 * The DB link is cleared only after the Cvent cancel succeeds, so a failed
 * cancel leaves the row pointing at a still-live appointment rather than
 * silently orphaning it. Per-meeting failures are collected and skipped so one
 * bad cancel doesn't abort the batch.
 *
 * lastPushedAt is deliberately kept.
 * Cvent never frees a cancelled appointment's `code`, and appointmentCode() in lib/cvent/push.ts builds the next code from lastPushedAt.
 *
 * @param {string} eventCode - The event the meetings belong to.
 * @param {ScheduledMeetingRow[]} syncedRows - The synced meetings to unpush.
 * @param {(row: ScheduledMeetingRow) => string} labelOf - Names a meeting for the report.
 * @returns {Promise<UnpushOutcome>} Counts plus per-meeting detail.
 */
export async function unpushMeetingRows(
    eventCode: string,
    syncedRows: ScheduledMeetingRow[],
    labelOf: (row: ScheduledMeetingRow) => string,
): Promise<UnpushOutcome> {
    return unpushAppointments(eventCode, syncedRows, labelOf, (row) =>
        // Unlinks the meeting in the DB so it reads as un-synced (row kept).
        // lastPushedAt stays so the next push gets a fresh code.
        db
            .update(scheduledMeetings)
            .set({ cventAppointmentId: null })
            .where(eq(scheduledMeetings.id, row.id)),
    );
}

/**
 * Cancels the Cvent appointment behind each synced row, then unlinks the row with the caller's unlink step.
 * Shared by meetings and roundtables, so both cancel the same way, with Cvent's emails suppressed when set.
 * The unlink step must clear only cventAppointmentId and keep lastPushedAt, as unpushMeetingRows does.
 *
 * @param {string} eventCode - The event the rows belong to.
 * @param {R[]} syncedRows - The synced rows to unpush.
 * @param {(row: R) => string} labelOf - Names a row for the report.
 * @param {(row: R) => Promise<unknown>} unlink - Clears the row's Cvent appointment id in the DB.
 * @returns {Promise<UnpushOutcome>} Counts plus per-row detail.
 */
export async function unpushAppointments<R extends UnpushRow>(
    eventCode: string,
    syncedRows: R[],
    labelOf: (row: R) => string,
    unlink: (row: R) => Promise<unknown>,
): Promise<UnpushOutcome> {
    const failures: UnpushDetail[] = [];
    const notes: UnpushDetail[] = [];
    let unpushed = 0;
    let alreadyGone = 0;

    for (const row of syncedRows) {
        // Guarded by the query above, but keep the type narrow for the DB call.
        if (!row.cventAppointmentId) continue;
        const label = labelOf(row);

        try {
            // Cancel in Cvent first, then unlink. Only clear once the cancel
            // succeeds, so a real failure leaves the row pointing at a live
            // appointment rather than silently orphaning it.
            await cancelAppointment(eventCode, row.cventAppointmentId);
            await unlink(row);
            unpushed++;
        } catch (err) {
            // If the appointment is already gone in Cvent (cancelled manually or
            // missing), there's nothing left to cancel — unlink locally anyway
            // and note it rather than treating it as a failure.
            if (isAppointmentAlreadyGone(err)) {
                await unlink(row);
                alreadyGone++;
                notes.push({
                    meetingId: row.id,
                    label,
                    detail: "Already cancelled or missing in Cvent — unsynced locally.",
                });
                continue;
            }

            // A genuine failure: leave the row synced. Prefer Cvent's
            // human-readable message when present.
            const base = err instanceof Error ? err.message : String(err);
            const cventMessage = parseCventError(
                (err as { body?: string }).body,
            ).message;
            failures.push({
                meetingId: row.id,
                label,
                detail: cventMessage ?? base,
            });
        }
    }

    return { unpushed, alreadyGone, failures, notes };
}
