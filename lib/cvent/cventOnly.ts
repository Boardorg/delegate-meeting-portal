import type { Attendee } from "@/types";
import type { CventExistingAppointment } from "@/lib/cvent/client";
import { partyId } from "@/lib/attendees/companies";

// ---------------------------------------------------------------------------
// Cvent appointments this portal's database has no meeting for.
//
// Each environment has its own database, but they all push to the same Cvent event.
// An appointment pushed by another environment, or made by hand in Cvent, is in Cvent but not here.
// The scheduler already counts these toward a company's maximum.
// These helpers let the meeting pages show and count them too, read-only.
// Pure, so they can be tested without Cvent or the database.
// ---------------------------------------------------------------------------

/** A Cvent appointment for one sponsor company that this database has no meeting for. */
export type CventOnlyAppointment = {
    /** Cvent appointment id. Null when Cvent omits it. */
    appointmentId: string | null;
    /** ISO 8601 UTC start time. */
    startTime: string;
    /** The appointment's location name. Null when Cvent omits it. */
    locationName: string | null;
    /** The delegates in the appointment. Empty when none is a known delegate. */
    delegates: Attendee[];
};

/**
 * Keeps the appointments this database has no meeting for.
 * An appointment Cvent sent without an id can't be matched, so it is kept.
 *
 * @param {CventExistingAppointment[]} appointments - The event's active Cvent appointments.
 * @param {Set<string>} knownAppointmentIds - Every Cvent appointment id stored on a meeting in this database.
 * @returns {CventExistingAppointment[]} The appointments with no meeting here.
 */
export function appointmentsNotInPortal(
    appointments: CventExistingAppointment[],
    knownAppointmentIds: Set<string>,
): CventExistingAppointment[] {
    return appointments.filter((a) => !a.id || !knownAppointmentIds.has(a.id));
}

/**
 * Maps each Cvent contact id to its attendee.
 *
 * @param {Attendee[]} attendees - The event's attendees.
 * @returns {Map<string, Attendee>} Attendees by Cvent contact id.
 */
function attendeesByContactId(attendees: Attendee[]): Map<string, Attendee> {
    const out = new Map<string, Attendee>();
    for (const a of attendees) {
        if (a.cventContactId) out.set(a.cventContactId, a);
    }
    return out;
}

/**
 * The sponsor companies in an appointment, by Account id.
 * A company is in it when one of its reps is a participant.
 *
 * @param {CventExistingAppointment} appointment - The appointment.
 * @param {Map<string, Attendee>} byContactId - Attendees by Cvent contact id.
 * @returns {Set<string>} The companies' Account ids.
 */
function companiesIn(
    appointment: CventExistingAppointment,
    byContactId: Map<string, Attendee>,
): Set<string> {
    const out = new Set<string>();
    for (const contactId of appointment.participantContactIds) {
        const a = byContactId.get(contactId);
        if (a?.role === "sponsor") out.add(partyId(a));
    }
    return out;
}

/**
 * Lists one sponsor company's Cvent appointments that this database has no meeting for, sorted by start time.
 * Participants Cvent lists but the portal doesn't know are left out.
 *
 * @param {{ appointments: CventExistingAppointment[]; attendees: Attendee[]; accountId: string; knownAppointmentIds: Set<string> }} params
 *   The event's active appointments, its attendees, the company and the appointment ids this database already has.
 * @returns {CventOnlyAppointment[]} The company's appointments with no meeting here.
 */
export function companyAppointmentsNotInPortal(params: {
    appointments: CventExistingAppointment[];
    attendees: Attendee[];
    accountId: string;
    knownAppointmentIds: Set<string>;
}): CventOnlyAppointment[] {
    const byContactId = attendeesByContactId(params.attendees);
    return appointmentsNotInPortal(params.appointments, params.knownAppointmentIds)
        .filter((appt) => companiesIn(appt, byContactId).has(params.accountId))
        .map((appt) => ({
            appointmentId: appt.id,
            startTime: appt.startTime,
            locationName: appt.locationName,
            delegates: appt.participantContactIds
                .map((id) => byContactId.get(id))
                .filter((a): a is Attendee => a?.role === "delegate"),
        }))
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/**
 * Counts each sponsor company's Cvent appointments that this database has no meeting for.
 *
 * @param {CventExistingAppointment[]} appointments - The event's active Cvent appointments.
 * @param {Attendee[]} attendees - The event's attendees.
 * @param {Set<string>} knownAppointmentIds - Every Cvent appointment id stored on a meeting in this database.
 * @returns {Map<string, number>} The count by company Account id. Companies with none are left out.
 */
export function countAppointmentsNotInPortal(
    appointments: CventExistingAppointment[],
    attendees: Attendee[],
    knownAppointmentIds: Set<string>,
): Map<string, number> {
    const byContactId = attendeesByContactId(attendees);
    const out = new Map<string, number>();
    for (const appt of appointmentsNotInPortal(appointments, knownAppointmentIds)) {
        for (const accountId of companiesIn(appt, byContactId)) {
            out.set(accountId, (out.get(accountId) ?? 0) + 1);
        }
    }
    return out;
}
