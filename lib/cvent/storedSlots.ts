import type { Timeslot } from "@/types";
import type { CventExistingAppointment } from "@/lib/cvent/client";
import type { EventScheduleData } from "@/lib/cvent/mapper";
import { kindForAppointmentType } from "@/lib/events/meetingKinds";

// ---------------------------------------------------------------------------
// Resolving a stored meeting's or roundtable's timeslot.
//
// Cvent's available-times list only lists free times.
// A booked time at a location that allows one appointment at a time drops out of it.
// So a pushed meeting's stored timeslot id can be missing from the event's timeslots.
// Its Cvent appointment still has the time, so the slot is rebuilt from the appointment.
// The rebuilt slot keeps the stored timeslot id, so lookups by that id keep working.
//
// Pure, so it can be tested without the database or Cvent.
// ---------------------------------------------------------------------------

/** The fields of a stored meeting or roundtable row that resolving its slot reads. */
export type StoredSlotRow = {
    timeslotId: string;
    cventAppointmentId: string | null;
    locationId: string | null;
};

/** The parts of an event's schedule data a slot is resolved from. */
export type SlotSources = Pick<
    EventScheduleData,
    "timeslots" | "timeslotById" | "locations" | "appointmentTypes" | "appointmentTypeKinds"
>;

/**
 * Reads the ISO date of a time, for day numbering.
 *
 * @param {string} iso - An ISO 8601 time.
 * @returns {string} The date as YYYY-MM-DD in UTC.
 */
function isoDate(iso: string): string {
    return new Date(iso).toISOString().slice(0, 10);
}

/**
 * Numbers event days the way toTimeslots in lib/cvent/mapper.ts does, by the order of distinct UTC dates.
 * A date that already has a listed slot keeps that slot's day.
 * Other dates are ranked among every date, listed or resolved.
 *
 * @param {Timeslot[]} timeslots - The event's listed timeslots.
 * @param {string[]} extraStarts - The start times of resolved slots.
 * @returns {(startTime: string) => Timeslot["day"]} The day of a start time.
 */
function dayNumbering(timeslots: Timeslot[], extraStarts: string[]): (startTime: string) => Timeslot["day"] {
    const listedDay = new Map<string, Timeslot["day"]>();
    for (const t of timeslots) listedDay.set(isoDate(t.startTime), t.day);
    const allDates = [...new Set([...timeslots.map((t) => isoDate(t.startTime)), ...extraStarts.map(isoDate)])].sort();
    return (startTime) => {
        const date = isoDate(startTime);
        return listedDay.get(date) ?? ((allDates.indexOf(date) + 1 || 1) as Timeslot["day"]);
    };
}

/**
 * Rebuilds a stored row's timeslot from its Cvent appointment.
 *
 * The time comes from the appointment. The location is the row's own, else the appointment's.
 * Cvent's appointment list usually names the type and location without their ids.
 * So the type id comes from the record when it has one, else from the event's types by name,
 * else from a listed slot at the same location.
 * The kind comes from the event's appointment-type mapping.
 *
 * @param {StoredSlotRow} row - The stored meeting or roundtable.
 * @param {CventExistingAppointment} appt - Its Cvent appointment.
 * @param {SlotSources} sources - The event's schedule data.
 * @param {(startTime: string) => Timeslot["day"]} dayOf - The event's day numbering.
 * @returns {Timeslot} The slot, keyed by the row's stored timeslot id.
 */
function slotFromAppointment(
    row: StoredSlotRow,
    appt: CventExistingAppointment,
    sources: SlotSources,
    dayOf: (startTime: string) => Timeslot["day"],
): Timeslot {
    const startTime = new Date(appt.startTime).toISOString();
    const locationId =
        row.locationId ??
        appt.locationId ??
        (appt.locationName ? sources.locations.find((l) => l.name === appt.locationName)?.id : undefined) ??
        null;
    // A listed slot at the same location, used for the type when the appointment doesn't name it.
    const sibling = locationId ? sources.timeslots.find((t) => t.locationId === locationId) : undefined;
    const typeByName = appt.typeName
        ? sources.appointmentTypes.find((t) => t.name.trim() === appt.typeName)
        : undefined;
    const appointmentTypeId = appt.typeId ?? typeByName?.id ?? sibling?.appointmentTypeId ?? "";
    const appointmentTypeName =
        appt.typeName ??
        sources.appointmentTypes.find((t) => t.id === appointmentTypeId)?.name ??
        sibling?.appointmentTypeName ??
        null;
    return {
        id: row.timeslotId,
        day: dayOf(startTime),
        startTime,
        endTime: appt.endTime ? new Date(appt.endTime).toISOString() : startTime,
        // The time is booked, and capacity isn't read for a stored row's slot.
        capacity: sibling?.capacity ?? 1,
        locationId,
        appointmentTypeId,
        appointmentTypeName,
        kind: appointmentTypeId
            ? kindForAppointmentType(sources.appointmentTypeKinds, appointmentTypeId)
            : (sibling?.kind ?? "ignore"),
    };
}

/**
 * Builds the slot lookup for stored rows.
 * It holds every listed timeslot, plus a slot rebuilt from the Cvent appointment of each row whose stored slot isn't listed.
 * A row whose appointment isn't in the active list stays missing.
 *
 * Use it only to read the slot of a stored meeting or roundtable.
 * Choosing a slot to book still uses the listed timeslots, so a full time is never offered.
 *
 * @param {SlotSources} sources - The event's schedule data.
 * @param {StoredSlotRow[]} rows - The stored meetings and roundtables.
 * @param {CventExistingAppointment[] | null} appointments - The event's active Cvent appointments. Null when they couldn't be read.
 * @returns {Map<string, Timeslot>} Slots by id, the listed ones and the rebuilt ones.
 */
export function storedSlotMap(
    sources: SlotSources,
    rows: StoredSlotRow[],
    appointments: CventExistingAppointment[] | null,
): Map<string, Timeslot> {
    const out = new Map(sources.timeslotById);
    const appointmentById = new Map(
        (appointments ?? []).filter((a) => a.id).map((a) => [a.id as string, a]),
    );
    const missing = rows
        .filter((r) => !out.has(r.timeslotId) && r.cventAppointmentId)
        .map((r) => ({ row: r, appt: appointmentById.get(r.cventAppointmentId as string) }))
        .filter((m): m is { row: StoredSlotRow; appt: CventExistingAppointment } => !!m.appt);
    const dayOf = dayNumbering(sources.timeslots, missing.map((m) => m.appt.startTime));
    for (const { row, appt } of missing) {
        if (!out.has(row.timeslotId)) out.set(row.timeslotId, slotFromAppointment(row, appt, sources, dayOf));
    }
    return out;
}

/**
 * The failure message when a stored row's slot can't be found, listed or through its Cvent appointment.
 *
 * @param {"meeting" | "roundtable"} what - Whether the row is a meeting or a roundtable.
 * @param {string} timeslotId - The stored timeslot id.
 * @returns {string} The message, with what to do next.
 */
export function missingSlotMessage(what: "meeting" | "roundtable", timeslotId: string): string {
    return what === "roundtable"
        ? `No Cvent timeslot found for id ${timeslotId}, and Cvent has no appointment for this roundtable to read it from. Unpush it and run grouping again.`
        : `No Cvent timeslot found for id ${timeslotId}, and Cvent has no appointment for this meeting to read it from. Move it to another slot.`;
}
