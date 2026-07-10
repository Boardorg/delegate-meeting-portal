import { Timeslot, MeetingRequest, ScheduledMeeting, Attendee } from '@/types';

/**
 * Produces a canonical, order-independent key for a pair of attendee IDs (e.g. `"d1|s2"`).
 *
 * @param {string} a - First attendee ID.
 * @param {string} b - Second attendee ID.
 * @returns {string} A stable key regardless of argument order.
 */
export function pairKey(a: string, b: string): string {

	// Sort the two IDs alphabetically so the key is the same regardless of which is passed first.
	return [a, b].sort().join('|');
}

/**
 * Computes the set of attendee pairs where both parties requested each other.
 *
 * @param {MeetingRequest[]} requests - The full list of meeting requests.
 * @returns {Set<string>} A set of canonical pair keys (via `pairKey`) for mutual pairs.
 */
export function computeMutualPairs(requests: MeetingRequest[]): Set<string> {

	// Build a fast lookup set of every directed request as "requesterId->targetId".
	const requestSet = new Set(requests.map(r => `${r.requesterId}->${r.targetId}`));

	// Initialize an empty set to hold the canonical keys of mutual pairs.
	const mutual = new Set<string>();

	// For each request, check whether the reverse request also exists.
	for (const r of requests) {
		if (requestSet.has(`${r.targetId}->${r.requesterId}`)) {

			// Store the pair using the canonical key so duplicates are automatically deduplicated.
			mutual.add(pairKey(r.requesterId, r.targetId));
		}
	}

	// Return the set of mutual pair keys.
	return mutual;
}

/**
 * Finds the first event-global timeslot on a given day that can host a meeting
 * between two attendees: both attendees must be free at that start time and the
 * timeslot must have remaining capacity. Timeslots are scanned in array order,
 * so callers control priority by ordering the input.
 *
 * @param {Timeslot[]} timeslots - The event's global timeslots.
 * @param {1 | 2} day - The event day to search within.
 * @param {Set<string>} busyA - Start times the first attendee is already booked at.
 * @param {Set<string>} busyB - Start times the second attendee is already booked at.
 * @param {Map<string, number>} remaining - Remaining capacity by timeslot id.
 * @returns {Timeslot | null} The first bookable timeslot, or null if none.
 */
export function findAvailableTimeslot(
	timeslots: Timeslot[],
	day: 1 | 2,
	busyA: Set<string>,
	busyB: Set<string>,
	remaining: Map<string, number>
): Timeslot | null {

	for (const ts of timeslots) {

		// Wrong day, or no capacity left in this timeslot.
		if (ts.day !== day) continue;
		if ((remaining.get(ts.id) ?? 0) <= 0) continue;

		// Either attendee already has a meeting at this start time.
		if (busyA.has(ts.startTime) || busyB.has(ts.startTime)) continue;

		return ts;
	}

	// No timeslot on this day works for both attendees.
	return null;
}

/**
 * Checks whether scheduling a meeting between two attendees would exceed the same-company cap.
 *
 * @param {ScheduledMeeting[]} scheduledMeetings - All meetings scheduled so far.
 * @param {Map<string, Attendee>} attendees - Lookup map of all attendees by ID.
 * @param {string} attendeeId - The attendee whose existing schedule is being checked.
 * @param {string} candidateId - The prospective meeting partner.
 * @param {number} maxSameCompany - Maximum allowed meetings with attendees from the same company.
 * @returns {boolean} `true` if adding this meeting would violate the diversity rule.
 */
export function wouldViolateCompanyDiversity(
	scheduledMeetings: ScheduledMeeting[],
	attendees: Map<string, Attendee>,
	attendeeId: string,
	candidateId: string,
	maxSameCompany: number
): boolean {

	// Look up the company of the person we're considering scheduling.
	const candidateCompany = attendees.get(candidateId)?.company;

	// If the candidate doesn't exist in the map, allow the meeting.
	if (!candidateCompany) return false;

	// Count how many of the attendee's existing meetings are with people from the same company.
	const sameCompanyCount = scheduledMeetings.filter(m => {
		const isInvolved = m.attendeeA === attendeeId || m.attendeeB === attendeeId;

		// Skip meetings this attendee isn't part of.
		if (!isInvolved) return false;

		// Determine which participant is the other person in the meeting.
		const otherId = m.attendeeA === attendeeId ? m.attendeeB : m.attendeeA;

		// Check if the other person's company matches the candidate's company.
		return attendees.get(otherId)?.company === candidateCompany;
	}).length;

	// Return true if adding this meeting would meet or exceed the cap.
	return sameCompanyCount >= maxSameCompany;
}
