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
import {
    appointmentTypeWarning,
    existingAppointmentLookup,
    hostBusyElsewhereLookup,
    sendAppointment,
    loadStoredSlots,
    type PushResult,
    type PushSummary,
    type SavePush,
} from "@/lib/cvent/push";
import { unpushAppointments, type UnpushOutcome } from "@/lib/cvent/unpush";
import { roundtableHostId } from "@/lib/matching/roundtables";
import { missingSlotMessage } from "@/lib/cvent/storedSlots";

// ---------------------------------------------------------------------------
// Pushing roundtables to Cvent.
//
// Each roundtable is one appointment of its slot's type, which is delegate_group.
// The theme title is the subject and the table's description is the description, exactly as stored.
// Roundtables are unmoderated, so the seated delegate with the lowest Salesforce id is the host.
// The other seated delegates are attendees. Alternates are never sent.
//
// Sending goes through sendAppointment in lib/cvent/push.ts, so a re-push works as for meetings.
// A replacement is created first and the old appointment is cancelled after that succeeds.
// When the replacement collides with the old appointment at the same time and type, the old one is updated in place.
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
 * A table already in Cvent is replaced, or updated in place on a same-time collision, as sendAppointment does for meetings.
 * A table with no theme title is refused with a message, and nothing is sent.
 * Failures are captured per table so one bad table doesn't stop the batch.
 *
 * Cvent rejects a host who is already in another appointment at that time.
 * So a table whose host already hosts a Cvent appointment then fails with a message, and nothing is sent.
 * Only the table's own appointment doesn't count, so the check doesn't depend on which tables are pushed or their order.
 *
 * @param {string} eventCode - The event the tables belong to.
 * @param {RoundtableRow[]} rows - The roundtables to push.
 * @param {RoundtableSeatRow[]} seats - Their seats. Alternates and other tables' seats are ignored.
 * @param {RoundtableRow[]} [eventTables] - Every roundtable of the event, to name another table that still holds a host in Cvent.
 *   Defaults to `rows`.
 * @returns {Promise<PushSummary>} Aggregate counts plus per-table results.
 */
export async function pushRoundtableRows(
    eventCode: string,
    rows: RoundtableRow[],
    seats: RoundtableSeatRow[],
    eventTables: RoundtableRow[] = rows,
): Promise<PushSummary> {
    if (rows.length === 0) {
        return { total: 0, pushed: 0, failed: 0, results: [] };
    }

    const [scheduleData, attendees] = await Promise.all([
        loadEventScheduleData(eventCode),
        loadAttendees(false, eventCode),
    ]);
    const attendeeById = new Map(attendees.map((a) => [a.salesforceId, a]));

    // Whether a delegate already hosts another Cvent appointment at a time, read once for the batch.
    const hostBusyElsewhere = await hostBusyElsewhereLookup(eventCode);
    // Existing appointments' times and types, read from Cvent only if a re-push collides with its old appointment.
    const existingAppointmentOf = existingAppointmentLookup(eventCode);
    // Each table's slot, rebuilt from its Cvent appointment when Cvent no longer lists the time.
    const slotById = await loadStoredSlots(eventCode, scheduleData, rows);
    /**
     * Names a roundtable by its theme and location.
     *
     * @param {RoundtableRow} table - The roundtable.
     * @returns {string} The label.
     */
    const labelOf = (table: RoundtableRow): string =>
        roundtableLabel(
            table,
            (table.locationId ? scheduleData.locationById.get(table.locationId)?.name : undefined) ?? "Unknown location",
        );
    // The event's pushed roundtables by Cvent appointment id, so a busy host can be traced to another table.
    const tableLabelByAppointmentId = new Map(
        [...eventTables, ...rows]
            .filter((t) => t.cventAppointmentId)
            .map((t) => [t.cventAppointmentId as string, labelOf(t)]),
    );

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

        // A pushed table whose time is no longer listed gets it from its Cvent appointment.
        const timeslot = slotById.get(row.timeslotId);
        if (!timeslot) {
            results.push(fail("missing_timeslot", missingSlotMessage("roundtable", row.timeslotId)));
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
            results.push(fail(
                "empty_table",
                row.cventAppointmentId
                    ? "No one is seated at this table, so it has no host to send to Cvent. Seat a delegate, or Unpush the table to cancel its Cvent appointment."
                    : "No one is seated at this table, so it has no host to send to Cvent.",
            ));
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
        // Only this table's own appointment is left out, so the result doesn't depend on push order.
        const busyWith = hostBusyElsewhere?.(timeslot.startTime, host.cventContactId, row.cventAppointmentId);
        if (busyWith) {
            // When the other appointment is another roundtable's, that table hasn't been pushed since the host moved.
            const otherTable = busyWith.id ? tableLabelByAppointmentId.get(busyWith.id) : undefined;
            results.push(fail(
                "host_busy",
                otherTable
                    ? `${host.name} still hosts ${otherTable} in Cvent at this time. Push that table first, then push this one again. If two hosts swapped tables, Unpush one of them first.`
                    : `${host.name} hosts this table but already hosts another Cvent appointment at this time. Move them off the table.`,
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
            await sendAppointment({
                eventCode,
                row,
                label,
                timeslot,
                input: {
                    subject,
                    // Sent exactly as stored. A cleared description is sent empty, not as the default.
                    description: row.description ?? "",
                    startTime: new Date(timeslot.startTime),
                    endTime: new Date(timeslot.endTime),
                    hostContactIds: [host.cventContactId],
                    appointmentTypeId: timeslot.appointmentTypeId,
                    locationId: row.locationId,
                    // Always a list, even an empty one, so an in-place update clears attendees who left the table.
                    attendeeContactIds,
                },
                warnings: [appointmentTypeWarning(timeslot, "delegate_group"), guestWarning],
                existingAppointmentOf,
                save: saveRoundtablePush(row.id),
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
 * Builds the save step for a roundtable's push.
 * lastPushedAt moves only when Cvent accepts the push, so the next code after an unpush is always new.
 *
 * @param {string} roundtableId - The roundtable.
 * @returns {SavePush} Writes the appointment id and push time on the table, and says whether the row was still there.
 */
function saveRoundtablePush(roundtableId: string): SavePush {
    return async (cventAppointmentId, pushedAt) => {
        const updated = await db
            .update(roundtables)
            .set({ cventAppointmentId, lastPushedAt: pushedAt })
            .where(eq(roundtables.id, roundtableId))
            .returning({ id: roundtables.id });
        return updated.length > 0;
    };
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
