import { AttendeeSlot, MeetingRequest, ScheduledMeeting, Attendee } from '@/types';

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
 * Finds the first pair of matching available slots between two attendees on a given day.
 * A valid pair requires both attendees to have an available slot at the same start time.
 *
 * @param {AttendeeSlot[]} slotsA - Slot array for the first attendee.
 * @param {AttendeeSlot[]} slotsB - Slot array for the second attendee.
 * @param {1 | 2} day - The event day to search within.
 * @returns {{ slotA: AttendeeSlot; slotB: AttendeeSlot } | null} The matched slot pair, or null if none found.
 */
export function findMutualSlot(
	slotsA: AttendeeSlot[],
	slotsB: AttendeeSlot[],
	day: 1 | 2
): { slotA: AttendeeSlot; slotB: AttendeeSlot } | null {

	// Filter each attendee's slots down to only available slots on the target day.
	const availableA = slotsA.filter(s => s.day === day && s.status === 'available');
	const availableB = slotsB.filter(s => s.day === day && s.status === 'available');

	// Build a map of startTime -> slot key-value pairs for attendee B.
	const mapB = new Map(availableB.map(s => [s.startTime, s]));

	// Loop through attendee A's available slots and return the first one that matches a B slot.
	for (const slotA of availableA) {

		// Try to get the corresponding slot from B that has the same start time.
		const slotB = mapB.get(slotA.startTime);

		// If a matching slot exists, return both slots as a pair.
		if (slotB) return { slotA, slotB };
	}

	// No overlapping available slot found.
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
