import { Attendee, Timeslot, MeetingRequest, ScheduledMeeting } from '@/types';
import { sponsorCompaniesByAccountId } from '@/lib/attendees/companies';

/**
 * Interest level given to a delegate's intake-form request.
 *
 * The form asks which sponsors a delegate wants to meet but not how badly, so
 * every derived request needs one assumed rank. 4 is the threshold the engine
 * treats as "high interest" (passes 2 and 3 gate on `rank >= 4`), so a delegate
 * preference is strong enough to be scheduled on its own in the delegate-choice
 * pass, without outranking a sponsor's explicit 5 when they compete for the same
 * slot.
 */
export const DELEGATE_PREFERENCE_RANK = 4;

/**
 * Merges each delegate's intake-form "sponsors I want to meet" list into the
 * request list as delegate→sponsor requests.
 *
 * Requests are the only currency the engine understands, so expressing the
 * preference this way is what wires it into the existing priority logic for
 * free: `computeMutualPairs` starts seeing delegate↔sponsor pairs as MUTUAL
 * when the sponsor also requested that delegate (passes 1 and 4), and an
 * unreciprocated preference becomes a delegate-choice candidate (pass 3).
 *
 * Targets are validated against the event's sponsor companies, so a stale or
 * foreign Account id in the form is ignored rather than surfacing as a
 * "not an attendee" row in the run report. A preference is also skipped when the
 * same directed pair already exists as a real portal request, so the submitted
 * rank always wins over the assumed one.
 *
 * @param {MeetingRequest[]} requests - Requests submitted through the portal.
 * @param {Attendee[]} attendees - The event's attendees, carrying the intake lists.
 * @returns {MeetingRequest[]} The requests plus the derived delegate preferences.
 */
export function withDelegatePreferences(
	requests: MeetingRequest[],
	attendees: Attendee[],
): MeetingRequest[] {

	// Only sponsors actually attending this event are valid targets.
	const sponsorAccountIds = new Set(sponsorCompaniesByAccountId(attendees).keys());

	// Directed keys already covered, so a real request beats a derived one and a
	// duplicated id within one delegate's answer only counts once.
	const seen = new Set(requests.map(r => `${r.requesterId}->${r.targetId}`));

	const derived: MeetingRequest[] = [];

	for (const attendee of attendees) {
		if (attendee.role !== 'delegate') continue;

		// Defensive: mock/fixture attendees may predate this field.
		for (const accountId of attendee.scheduling.requestedSponsorAccountIds ?? []) {
			if (!sponsorAccountIds.has(accountId)) continue;

			const key = `${attendee.salesforceId}->${accountId}`;
			if (seen.has(key)) continue;
			seen.add(key);

			derived.push({
				// Prefixed so a derived request is recognizable in a report or log
				// and can't collide with a DB row's numeric id.
				id: `pref:${attendee.salesforceId}:${accountId}`,
				requesterId: attendee.salesforceId,
				targetId: accountId,
				rank: DELEGATE_PREFERENCE_RANK,
			});
		}
	}

	// Preserve the caller's array identity when there's nothing to add.
	return derived.length > 0 ? [...requests, ...derived] : requests;
}

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
 * Checks whether scheduling a meeting between two parties would exceed the
 * same-company cap. Parties are compared by `companyKey` — the Salesforce
 * Account id (for sponsors, this is the party id itself; for delegates, their
 * employer's account id) — rather than the company name string, so distinct
 * companies that happen to share a name aren't conflated and reps of one
 * company are treated as one.
 *
 * @param {ScheduledMeeting[]} scheduledMeetings - All meetings scheduled so far.
 * @param {Map<string, { companyKey: string }>} entities - Party-id → scheduling entity (carrying its companyKey).
 * @param {string} attendeeId - The party whose existing schedule is being checked.
 * @param {string} candidateId - The prospective meeting partner (party id).
 * @param {number} maxSameCompany - Maximum allowed meetings with the same company.
 * @returns {boolean} `true` if adding this meeting would violate the diversity rule.
 */
export function wouldViolateCompanyDiversity(
	scheduledMeetings: ScheduledMeeting[],
	entities: Map<string, { companyKey: string }>,
	attendeeId: string,
	candidateId: string,
	maxSameCompany: number
): boolean {

	// The company (account key) of the party we're considering scheduling.
	const candidateKey = entities.get(candidateId)?.companyKey;

	// If the candidate isn't in the map, allow the meeting.
	if (!candidateKey) return false;

	// Count how many of this party's existing meetings are with the same company.
	const sameCompanyCount = scheduledMeetings.filter(m => {
		const isInvolved = m.attendeeA === attendeeId || m.attendeeB === attendeeId;

		// Skip meetings this party isn't part of.
		if (!isInvolved) return false;

		// Determine the other party in the meeting.
		const otherId = m.attendeeA === attendeeId ? m.attendeeB : m.attendeeA;

		// Check if the other party's company matches the candidate's.
		return entities.get(otherId)?.companyKey === candidateKey;
	}).length;

	// Return true if adding this meeting would meet or exceed the cap.
	return sameCompanyCount >= maxSameCompany;
}
