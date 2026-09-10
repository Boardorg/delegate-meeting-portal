import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { scheduledMeetings, type ScheduledMeetingRow } from "@/lib/db/schema";
import { loadEventScheduleData } from "@/lib/cvent/mapper";
import { loadAttendees } from "@/lib/attendees/loader";
import {
    sponsorCompaniesByAccountId,
    cventContactIdsOfCompany,
} from "@/lib/attendees/companies";
import { createAppointment, cancelAppointment } from "@/lib/cvent/client";
import { isTestingMode } from "@/lib/helpers/testingMode";
import {
    classifyPushError,
    parseCventError,
    type MeetingSyncOutcome,
} from "@/lib/cvent/syncReport";

// ---------------------------------------------------------------------------
// Shared push-to-Cvent logic
//
// One place that turns scheduled_meetings rows into Cvent appointments and
// reports, per meeting, whether it succeeded and why not. Used by both the
// event-wide and per-sponsor push actions so their behavior stays identical
// and callers get structured results to show in the UI.
// ---------------------------------------------------------------------------

/**
 * Result of pushing a single meeting to Cvent. Extends the report's
 * MeetingSyncOutcome (meetingId, label, ok, kind, reason, error, warning) with
 * the created appointment id.
 */
export interface PushResult extends MeetingSyncOutcome {
    /** The Cvent appointment id on success. */
    cventAppointmentId?: string | null;
}

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
 * Turns a thrown push error into a message for the result row.
 *
 * In all modes it surfaces Cvent's human-readable message from the response body
 * when present (e.g. a 409 "no more appointments at this time"), since those are
 * actionable for admins. In testing mode it further expands into the detail the
 * SDK hides — pretty-printed validation issues, HTTP status, and the raw body —
 * for debugging. Otherwise it falls back to the terse `err.message`.
 *
 * @param {unknown} err - The thrown error.
 * @returns {string} The (possibly expanded) error message.
 */
function describePushError(err: unknown): string {
    const base = err instanceof Error ? err.message : String(err);
    if (!(err instanceof Error)) return base;

    // Duck-typed against the Cvent SDK error shapes (ResponseValidationError /
    // CventSDKError) so we don't hard-depend on their classes.
    const e = err as {
        pretty?: () => string;
        statusCode?: number;
        body?: string;
        cause?: unknown;
    };

    const cventMessage = parseCventError(e.body).message;

    // Outside testing mode: prefer Cvent's message when there is one; otherwise
    // keep it terse and don't leak raw responses into the admin UI.
    if (!isTestingMode()) {
        return cventMessage ?? base;
    }

    const parts: string[] = [base];
    if (cventMessage) parts.push(cventMessage);
    if (typeof e.pretty === "function") {
        const pretty = e.pretty();
        if (pretty && pretty !== base) parts.push(pretty);
    }
    if (typeof e.statusCode === "number") parts.push(`HTTP ${e.statusCode}`);
    if (typeof e.body === "string" && e.body.trim())
        parts.push(`Response body: ${e.body}`);
    if (e.cause && e.cause !== err) {
        parts.push(
            `Cause: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}`,
        );
    }
    return parts.join("\n");
}

/**
 * Whether a portal meeting still needs pushing to Cvent: it was never synced,
 * or it was modified since its last push. Used to partition an event's (or a
 * sponsor's) meetings into "to push" vs "already synced" for the sync report.
 *
 * @param {ScheduledMeetingRow} row - The meeting row.
 * @returns {boolean} True when the row should be pushed.
 */
export function needsSync(row: ScheduledMeetingRow): boolean {
    return (
        !row.cventAppointmentId ||
        (row.lastModifiedAt != null &&
            row.lastPushedAt != null &&
            row.lastModifiedAt > row.lastPushedAt)
    );
}

/**
 * Pushes a set of scheduled-meeting rows to Cvent.
 *
 * A row not yet synced gets a new appointment.
 * A row already synced and edited since gets a replacement appointment instead.
 * The new appointment is created first. The old one is only cancelled after that succeeds.
 * This way a failed push still leaves the meeting with a working appointment.
 * The replacement gets a timestamp-suffixed code, since Cvent keeps the old code reserved even after cancellation.
 *
 * Resolves each meeting's time from its Cvent timeslot and maps participants
 * from Salesforce ids to Cvent contact ids. On success it writes back the
 * appointment id + push time; failures are captured per row so one bad
 * meeting doesn't abort the batch.
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
    // Delegates (the appointment attendee) resolve by salesforceId; the sponsor
    // side (attendeeA = a company Account id) resolves to a SponsorCompany whose
    // reps all become hosts.
    const attendeeById = new Map(attendees.map((a) => [a.salesforceId, a]));
    const companiesByAccountId = sponsorCompaniesByAccountId(attendees);

    const results: PushResult[] = [];
    for (const row of rows) {
        // attendeeA is the requesting COMPANY (party id = Account id); every one
        // of its reps hosts the Cvent appointment. attendeeB is the target
        // delegate — the single appointment attendee.
        const company = companiesByAccountId.get(row.attendeeA);
        const target = attendeeById.get(row.attendeeB);
        const label = `${company?.name ?? row.attendeeA} & ${target?.name ?? row.attendeeB}`;

        // A row with an existing appointment is a replacement (update); a fresh
        // row is a create. Recorded on every result so the report can split
        // successes into created vs updated.
        const oldAppointmentId = row.cventAppointmentId;
        const kind = oldAppointmentId ? "update" : "create";

        // A meeting can't be pushed without a resolvable time block.
        const timeslot = scheduleData.timeslotById.get(row.timeslotId);
        if (!timeslot) {
            results.push({
                meetingId: row.id,
                label,
                ok: false,
                kind,
                reason: "missing_timeslot",
                error: `No Cvent timeslot found for id ${row.timeslotId}.`,
            });
            continue;
        }

        // Cvent appointments must be placed in a location.
        if (!row.locationId) {
            results.push({
                meetingId: row.id,
                label,
                ok: false,
                kind,
                reason: "missing_location",
                error: "The meeting has no location assigned to send to Cvent.",
            });
            continue;
        }

        // All of the company's reps host the appointment, so at least one must
        // have a Cvent contact id. This single guard covers both an unresolved
        // company (attendeeA not found) and a company whose reps are all missing
        // Cvent links.
        const hostContactIds = company
            ? cventContactIdsOfCompany(company)
            : [];
        if (hostContactIds.length === 0) {
            results.push({
                meetingId: row.id,
                label,
                ok: false,
                kind,
                reason: "host_not_in_cvent",
                error: `No rep of ${company?.name ?? row.attendeeA} has a Cvent contact id to host the appointment. Confirm the company's reps are Cvent attendees for this event.`,
            });
            continue;
        }

        // Non-fatal note when some — but not all — reps are missing a Cvent
        // link, so they're absent as hosts on the created appointment.
        const missingHostReps = (company?.reps ?? [])
            .filter((r) => !r.cventContactId)
            .map((r) => r.name);
        const hostWarning =
            missingHostReps.length > 0
                ? `${missingHostReps.join(", ")} ${missingHostReps.length === 1 ? "isn't" : "aren't"} linked in Cvent, so ${missingHostReps.length === 1 ? "that rep was" : "those reps were"} not added as hosts.`
                : undefined;

        // The single appointment attendee is the target delegate's contact id
        // when known. A missing target contact id isn't fatal (the appointment
        // is created without an attendee) but is worth flagging.
        const attendeeContactIds = target?.cventContactId
            ? [target.cventContactId]
            : [];
        const targetWarning = target?.cventContactId
            ? undefined
            : `${target?.name ?? row.attendeeB} isn't linked in Cvent, so the appointment was created without them as a participant.`;

        // A never-pushed row can reuse its own id as the code, since it's unused.
        // A repushed row needs a fresh code, since Cvent keeps the old one attached to the appointment being cancelled.
        // A timestamp suffix is enough to make it fresh without a DB round trip.
        const code = oldAppointmentId ? `${row.id}-${Date.now()}` : row.id;

        const input = {
            subject: label,
            startTime: new Date(timeslot.startTime),
            endTime: new Date(timeslot.endTime),
            hostContactIds,
            appointmentTypeId: timeslot.appointmentTypeId,
            locationId: row.locationId,
            attendeeContactIds,
            code,
        };

        try {
            const cventAppointmentId = await createAppointment(
                eventCode,
                input,
            );

            // Collect non-fatal notes for an otherwise-successful push.
            const notes: string[] = [];
            if (hostWarning) notes.push(hostWarning);
            if (targetWarning) notes.push(targetWarning);

            // Only cancel the old appointment once the replacement exists.
            // This can't undo the create, so a failure here is reported as a
            // warning rather than failing a push that otherwise succeeded.
            if (oldAppointmentId) {
                try {
                    await cancelAppointment(eventCode, oldAppointmentId);
                } catch (cancelErr) {
                    notes.push(
                        `Created the new appointment, but failed to cancel the previous one (${oldAppointmentId}): ${describePushError(cancelErr)}`,
                    );
                }
            }

            await db
                .update(scheduledMeetings)
                .set({ cventAppointmentId, lastPushedAt: new Date() })
                .where(eq(scheduledMeetings.id, row.id));

            results.push({
                meetingId: row.id,
                label,
                ok: true,
                kind,
                cventAppointmentId,
                warning: notes.length ? notes.join(" ") : undefined,
            });
        } catch (err) {
            results.push({
                meetingId: row.id,
                label,
                ok: false,
                kind,
                reason: classifyPushError(err),
                error: describePushError(err),
            });
        }
    }

    const pushed = results.filter((r) => r.ok).length;
    return {
        total: results.length,
        pushed,
        failed: results.length - pushed,
        results,
    };
}
