import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
    roundtables,
    type RoundtableRow,
    type RoundtableSeatRow,
} from "@/lib/db/schema";
import { loadEventScheduleData } from "@/lib/cvent/mapper";
import { loadAttendees } from "@/lib/attendees/loader";
import { createAppointment, updateAppointment } from "@/lib/cvent/client";
import {
    appointmentCode,
    appointmentTypeWarning,
    busyHostLookup,
    describePushError,
    type PushResult,
    type PushSummary,
} from "@/lib/cvent/push";
import { unpushAppointments, type UnpushOutcome } from "@/lib/cvent/unpush";
import { classifyPushError } from "@/lib/cvent/syncReport";
import { roundtableHostId } from "@/lib/matching/roundtables";
import type { CventAppointmentInput } from "@/lib/cvent/client";

// ---------------------------------------------------------------------------
// Pushing roundtables to Cvent.
//
// Each roundtable is one appointment of its slot's type, which is delegate_group.
// The theme title is the subject and the table's description is the description, exactly as stored.
// Roundtables are unmoderated, so the seated delegate with the lowest Salesforce id is the host.
// The other seated delegates are attendees. Alternates are never sent.
//
// A table already in Cvent is always updated in place, never replaced.
// Its time and type can't change, so a replacement would only collide with the old appointment.
// Unpush cancels through the shared unpush step, so Cvent's emails are suppressed when set.
// ---------------------------------------------------------------------------

/**
 * Names a roundtable in push and unpush reports.
 *
 * @param {Pick<RoundtableRow, "themeTitle">} row - The roundtable.
 * @param {string} location - The table's location name.
 * @returns {string} The theme title and location, or just the location when there is no theme yet.
 */
export function roundtableLabel(
    row: Pick<RoundtableRow, "themeTitle">,
    location: string,
): string {
    const theme = row.themeTitle?.trim();
    return theme ? `${theme} (${location})` : location;
}

/**
 * Pushes roundtables to Cvent.
 *
 * A table not yet in Cvent gets a new appointment with a code from appointmentCode().
 * A table already in Cvent is updated in place, so a new theme, description or host lands on the same appointment.
 * A table with no theme title is refused with a message, and nothing is sent.
 * Failures are captured per table so one bad table doesn't stop the batch.
 *
 * Cvent rejects a host who is already in another appointment at that time.
 * So a table whose host already hosts a Cvent appointment then fails with a message, and nothing is sent.
 * The table's own appointment doesn't count, since an update keeps it.
 *
 * @param {string} eventCode - The event the tables belong to.
 * @param {RoundtableRow[]} rows - The roundtables to push.
 * @param {RoundtableSeatRow[]} seats - Their seats. Alternates and other tables' seats are ignored.
 * @returns {Promise<PushSummary>} Aggregate counts plus per-table results.
 */
export async function pushRoundtableRows(
    eventCode: string,
    rows: RoundtableRow[],
    seats: RoundtableSeatRow[],
): Promise<PushSummary> {
    if (rows.length === 0) {
        return { total: 0, pushed: 0, failed: 0, results: [] };
    }

    const [scheduleData, attendees] = await Promise.all([
        loadEventScheduleData(eventCode),
        loadAttendees(false, eventCode),
    ]);
    const attendeeById = new Map(attendees.map((a) => [a.salesforceId, a]));

    // Which delegates already host a Cvent appointment at each time.
    // The tables' own appointments are left out, since an update keeps them.
    const ownAppointmentIds = new Set(
        rows
            .map((r) => r.cventAppointmentId)
            .filter((id): id is string => !!id),
    );
    const busyHostsAt = await busyHostLookup(eventCode, ownAppointmentIds);

    const results: PushResult[] = [];
    for (const row of rows) {
        const location =
            (row.locationId
                ? scheduleData.locationById.get(row.locationId)?.name
                : undefined) ?? "Unknown location";
        const label = roundtableLabel(row, location);
        const kind = row.cventAppointmentId ? "update" : "create";
        /**
         * Builds a failed result for this table.
         *
         * @param {PushResult["reason"]} reason - Why it failed.
         * @param {string} error - What to tell the admin.
         * @returns {PushResult} The failed result.
         */
        const fail = (reason: PushResult["reason"], error: string): PushResult => ({
            meetingId: row.id,
            label,
            ok: false,
            kind,
            reason,
            error,
        });

        // The theme title is the appointment's subject, so a table without one can't be pushed.
        const subject = row.themeTitle?.trim() ?? "";
        if (!subject) {
            results.push(fail(
                "missing_theme",
                `${location} has no theme title. Enter one on the table's page, then push again.`,
            ));
            continue;
        }

        const timeslot = scheduleData.timeslotById.get(row.timeslotId);
        if (!timeslot) {
            results.push(fail("missing_timeslot", `No Cvent timeslot found for id ${row.timeslotId}.`));
            continue;
        }
        // Cvent fails a create without a location, even for a real slot.
        if (!row.locationId) {
            results.push(fail("missing_location", "The roundtable has no location to send to Cvent."));
            continue;
        }

        // Seated delegates in seat order. Alternates are never sent.
        const seatedIds = seats
            .filter((s) => s.roundtableId === row.id && s.role === "seated")
            .sort((x, y) => x.position - y.position)
            .map((s) => s.delegateId);
        const hostId = roundtableHostId(seatedIds);
        if (!hostId) {
            results.push(fail("empty_table", "No one is seated at this table, so it has no host to send to Cvent."));
            continue;
        }

        // A delegate who cancelled their Cvent registration can't be an appointment participant.
        const cancelled = seatedIds
            .map((id) => attendeeById.get(id))
            .find((d) => d?.cventCancelled);
        if (cancelled) {
            results.push(fail(
                "attendee_cancelled",
                `${cancelled.name} cancelled their Cvent registration. Move them off this table.`,
            ));
            continue;
        }

        const host = attendeeById.get(hostId);
        if (!host?.cventContactId) {
            results.push(fail(
                "host_not_in_cvent",
                `${host?.name ?? hostId} hosts this table but isn't linked in Cvent. Confirm they are a Cvent attendee for this event, or move them off the table.`,
            ));
            continue;
        }

        // Cvent rejects a host who is already in another appointment at that time.
        if (busyHostsAt?.(timeslot.startTime).has(host.cventContactId)) {
            results.push(fail(
                "host_not_in_cvent",
                `${host.name} hosts this table but already hosts another Cvent appointment at this time. Move them off the table.`,
            ));
            continue;
        }

        // The other seated delegates are attendees. One not linked in Cvent is left off with a warning.
        const guests = seatedIds
            .filter((id) => id !== hostId)
            .map((id) => ({ id, attendee: attendeeById.get(id) }));
        const attendeeContactIds = guests
            .map((g) => g.attendee?.cventContactId)
            .filter((id): id is string => !!id);
        const unlinked = guests
            .filter((g) => !g.attendee?.cventContactId)
            .map((g) => g.attendee?.name ?? g.id);
        const guestWarning =
            unlinked.length > 0
                ? `${unlinked.join(", ")} ${unlinked.length === 1 ? "isn't" : "aren't"} linked in Cvent, so ${unlinked.length === 1 ? "that delegate was" : "those delegates were"} left off the appointment.`
                : undefined;

        results.push(
            await sendRoundtable({
                eventCode,
                row,
                label,
                input: {
                    subject,
                    // Sent exactly as stored. A cleared description is sent empty, not as the default.
                    description: row.description ?? "",
                    startTime: new Date(timeslot.startTime),
                    endTime: new Date(timeslot.endTime),
                    hostContactIds: [host.cventContactId],
                    appointmentTypeId: timeslot.appointmentTypeId,
                    locationId: row.locationId,
                    attendeeContactIds,
                },
                warnings: [appointmentTypeWarning(timeslot, "delegate_group"), guestWarning],
            }),
        );
    }

    const pushed = results.filter((r) => r.ok).length;
    return {
        total: results.length,
        pushed,
        failed: results.length - pushed,
        results,
    };
}

/**
 * Sends one roundtable's appointment to Cvent and saves the result on its row.
 *
 * A table not yet in Cvent is created with a code from appointmentCode().
 * A table already in Cvent is updated in place, keeping its appointment id.
 * lastPushedAt moves only when Cvent accepts the push, so the next code after an unpush is always new.
 *
 * @param {{ eventCode: string; row: RoundtableRow; label: string; input: Omit<CventAppointmentInput, "code">; warnings: (string | undefined)[] }} params
 *   The table, its label, the appointment to send, and non-fatal notes for a success.
 * @returns {Promise<PushResult>} The table's outcome.
 */
async function sendRoundtable(params: {
    eventCode: string;
    row: RoundtableRow;
    label: string;
    input: Omit<CventAppointmentInput, "code">;
    warnings: (string | undefined)[];
}): Promise<PushResult> {
    const { eventCode, row, label } = params;
    const existingId = row.cventAppointmentId;
    const kind = existingId ? "update" : "create";
    try {
        const cventAppointmentId = existingId
            ? await updateAppointment(eventCode, existingId, params.input)
            : await createAppointment(eventCode, { ...params.input, code: appointmentCode(row) });

        await db
            .update(roundtables)
            .set({ cventAppointmentId, lastPushedAt: new Date() })
            .where(eq(roundtables.id, row.id));

        const notes = params.warnings.filter((w): w is string => !!w);
        return {
            meetingId: row.id,
            label,
            ok: true,
            kind,
            cventAppointmentId,
            warning: notes.length ? notes.join(" ") : undefined,
        };
    } catch (err) {
        return {
            meetingId: row.id,
            label,
            ok: false,
            kind,
            reason: classifyPushError(err),
            error: describePushError(err),
        };
    }
}

/**
 * Cancels the Cvent appointment behind each synced roundtable, then unlinks the table.
 * The table keeps its seats, theme, description and lastPushedAt, so the next push gets a fresh code.
 * Cancelling suppresses Cvent's emails when CVENT_SUPPRESS_NOTIFICATIONS is set.
 *
 * @param {string} eventCode - The event the tables belong to.
 * @param {RoundtableRow[]} syncedRows - The synced roundtables to unpush.
 * @param {(row: RoundtableRow) => string} labelOf - Names a table for the report.
 * @returns {Promise<UnpushOutcome>} Counts plus per-table detail.
 */
export async function unpushRoundtableRows(
    eventCode: string,
    syncedRows: RoundtableRow[],
    labelOf: (row: RoundtableRow) => string,
): Promise<UnpushOutcome> {
    return unpushAppointments(eventCode, syncedRows, labelOf, (row) =>
        db
            .update(roundtables)
            .set({ cventAppointmentId: null })
            .where(eq(roundtables.id, row.id)),
    );
}
