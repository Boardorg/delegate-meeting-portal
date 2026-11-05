import type { Attendee } from "@/types";
import type { CventExistingAppointment } from "@/lib/cvent/client";
import type { PreexistingSchedule } from "@/lib/scheduling/engine";
import { pairKey, slotRoomKey } from "@/lib/scheduling/helpers";
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
 * Busy times are a count per start time, one for each appointment the party is in then.
 * A company can hold more than one meeting at a time, so its existing
 * appointments count toward that limit instead of blocking the time outright.
 * Each appointment counts once per party, however many of the company's reps host it.
 *
 * It also records, for the run:
 * - how many appointments each party already has in Cvent, so they count toward its maximum.
 * - which of a party's contacts host at each start time, so a company's later meeting then only gets free reps.
 * - how many appointments are at each location and start time, so a slot's room is Cvent's setting minus those.
 *   Appointments carry only a location name, so slots are matched by name and start time.
 *
 * Start times are normalized to ISO strings with milliseconds, the same form the scheduler's timeslots use.
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

    const busyStartTimesByAttendee = new Map<string, Map<string, number>>();
    const meetingCountByParty = new Map<string, number>();
    const busyHostsByParty = new Map<string, Map<string, Set<string>>>();
    const bookedBySlot = new Map<string, number>();
    const pairs = new Set<string>();

    for (const appt of appointments) {
        const parsed = new Date(appt.startTime);
        if (Number.isNaN(parsed.getTime())) continue;
        const startTime = parsed.toISOString();

        // One more appointment at this location and start time.
        if (appt.locationName) {
            const key = slotRoomKey(appt.locationName, startTime);
            bookedBySlot.set(key, (bookedBySlot.get(key) ?? 0) + 1);
        }

        // The hosts are busy at this start time, under their party.
        for (const hostId of appt.hostContactIds) {
            const party = partyIdByContactId.get(hostId);
            if (!party) continue;
            const byTime = busyHostsByParty.get(party) ?? new Map<string, Set<string>>();
            const hosts = byTime.get(startTime) ?? new Set<string>();
            hosts.add(hostId);
            byTime.set(startTime, hosts);
            busyHostsByParty.set(party, byTime);
        }

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

        // Each party has one more appointment at this start time, and one more in total.
        for (const id of ids) {
            const counts =
                busyStartTimesByAttendee.get(id) ?? new Map<string, number>();
            counts.set(startTime, (counts.get(startTime) ?? 0) + 1);
            busyStartTimesByAttendee.set(id, counts);
            meetingCountByParty.set(id, (meetingCountByParty.get(id) ?? 0) + 1);
        }

        // Every pair among the parties already meets — don't re-schedule it.
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                pairs.add(pairKey(ids[i], ids[j]));
            }
        }
    }

    return {
        pairs,
        busyStartTimesByAttendee,
        meetingCountByParty,
        busyHostsByParty,
        bookedBySlot,
    };
}
