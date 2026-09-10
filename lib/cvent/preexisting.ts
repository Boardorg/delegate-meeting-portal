import type { Attendee } from "@/types";
import type { CventExistingAppointment } from "@/lib/cvent/client";
import type { PreexistingSchedule } from "@/lib/scheduling/engine";
import { pairKey } from "@/lib/scheduling/helpers";
import { partyId } from "@/lib/attendees/companies";

// ---------------------------------------------------------------------------
// Cvent appointments → engine pre-existing schedule.
//
// Pure reducer (no network / DB) so it can be unit-tested and reused. Lives
// outside the "use server" admin action file, which may only export async
// functions.
// ---------------------------------------------------------------------------

/**
 * Reduces a set of Cvent appointments to the engine's pre-existing schedule:
 * which PARTY pairs already meet, and the start times each party is already
 * booked at. Cvent participant contact ids are mapped to PARTY ids (a sponsor
 * rep's contact → its company Account id; a delegate's → its salesforceId), so
 * every rep of a company collapses to the one company party — its reps' busy
 * times union under it and intra-company rep↔rep pairs never form.
 * Unrecognized participants are ignored.
 *
 * @param {CventExistingAppointment[]} appointments - Existing Cvent appointments.
 * @param {Attendee[]} attendees - Loaded attendees, for contact-id → party-id mapping.
 * @returns {PreexistingSchedule} Pairs + per-party busy times to schedule around.
 */
export function preexistingFromAppointments(
    appointments: CventExistingAppointment[],
    attendees: Attendee[],
): PreexistingSchedule {
    // Cvent contact id → our party id, to translate appointment participants.
    const partyIdByContactId = new Map<string, string>();
    for (const a of attendees) {
        if (a.cventContactId) partyIdByContactId.set(a.cventContactId, partyId(a));
    }

    const busyStartTimesByAttendee = new Map<string, Set<string>>();
    const pairs = new Set<string>();

    for (const appt of appointments) {
        // Map participants to party ids and dedupe — all of a company's reps
        // collapse to one account id, so a multi-host appointment yields a
        // single company party (no self/rep↔rep pairs).
        const ids = [
            ...new Set(
                appt.participantContactIds
                    .map((cid) => partyIdByContactId.get(cid))
                    .filter((id): id is string => !!id),
            ),
        ];

        // Each party is busy at this appointment's start time.
        for (const id of ids) {
            const set = busyStartTimesByAttendee.get(id) ?? new Set<string>();
            set.add(appt.startTime);
            busyStartTimesByAttendee.set(id, set);
        }

        // Every pair among the parties already meets — don't re-schedule it.
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                pairs.add(pairKey(ids[i], ids[j]));
            }
        }
    }

    return { pairs, busyStartTimesByAttendee };
}
