import { Attendee, Timeslot, MeetingRequest, ScheduledMeeting } from '@/types';
import { sponsorCompaniesByAccountId } from '@/lib/attendees/companies';
import type { MeetingKind } from '@/lib/events/meetingKinds';

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

/** Shown when a scheduler run stops because no sponsors or no delegates were loaded. */
export const NO_ATTENDEES_MESSAGE =
	'No sponsors or delegates were found for this event, so nothing was changed. ' +
	'Cvent may be unreachable. Try again in a few minutes.';

/**
 * Whether the attendees a scheduler run would use include at least one sponsor rep and one delegate.
 * The attendee loader returns no one when Cvent's attendee lookup fails.
 * A run without both sides would delete every un-pushed meeting and create none.
 *
 * @param {Attendee[]} attendees - The attendees the scheduler would use, with cancelled ones already left out.
 * @returns {boolean} True when there is at least one sponsor and one delegate.
 */
export function hasSponsorsAndDelegates(attendees: Attendee[]): boolean {
	return (
		attendees.some(a => a.role === 'sponsor') &&
		attendees.some(a => a.role === 'delegate')
	);
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
 * The start times a party is already booked at.
 * A set lists each busy start time once.
 * A map gives how many meetings the party already has at each start time.
 */
export type BusyTimes = ReadonlySet<string> | ReadonlyMap<string, number>;

/**
 * How many meetings a party already has at a start time.
 *
 * @param {BusyTimes} busy - The party's busy times.
 * @param {string} startTime - The start time to check.
 * @returns {number} The count, 0 when the party is free then.
 */
export function busyCountAt(busy: BusyTimes, startTime: string): number {
	if (busy instanceof Map) return busy.get(startTime) ?? 0;
	return (busy as ReadonlySet<string>).has(startTime) ? 1 : 0;
}

/**
 * Optional limits on which timeslot findAvailableTimeslot may pick.
 */
export type SlotLimits = {
	/**
	 * The only location the meeting may use, such as a sponsor company's booth.
	 * Leave it out to allow any location.
	 */
	locationId?: string;
	/** How many meetings the first party may hold at one start time. Defaults to 1. */
	limitA?: number;
	/** How many meetings the second party may hold at one start time. Defaults to 1. */
	limitB?: number;
};

/**
 * Finds the first event-global timeslot on a given day that can host a meeting
 * between two attendees: both attendees must be free at that start time and the
 * timeslot must have remaining capacity. Timeslots are scanned in array order,
 * so callers control priority by ordering the input.
 *
 * Only timeslots of the given meeting kind are considered.
 * A sponsor meeting must land in a `sponsor_delegate` slot, even when a slot of another kind is free and earlier.
 *
 * A party counts as free at a start time while it has fewer meetings then than its at-once limit.
 * The limit is 1 unless `limits` says otherwise, so by default a party is busy once it has one meeting.
 * When `limits.locationId` is set, only timeslots at that location are considered.
 *
 * @param {Timeslot[]} timeslots - The event's global timeslots.
 * @param {1 | 2} day - The event day to search within.
 * @param {BusyTimes} busyA - Start times the first attendee is already booked at.
 * @param {BusyTimes} busyB - Start times the second attendee is already booked at.
 * @param {Map<string, number>} remaining - Remaining capacity by timeslot id.
 * @param {MeetingKind} kind - The meeting kind the timeslot must be mapped to.
 * @param {SlotLimits} [limits] - The allowed location and each party's at-once limit.
 * @returns {Timeslot | null} The first bookable timeslot, or null if none.
 */
export function findAvailableTimeslot(
	timeslots: Timeslot[],
	day: 1 | 2,
	busyA: BusyTimes,
	busyB: BusyTimes,
	remaining: Map<string, number>,
	kind: MeetingKind,
	limits: SlotLimits = {},
): Timeslot | null {

	const limitA = limits.limitA ?? 1;
	const limitB = limits.limitB ?? 1;

	for (const ts of timeslots) {

		// Wrong day, wrong meeting kind, or no capacity left in this timeslot.
		if (ts.day !== day) continue;
		if (ts.kind !== kind) continue;
		if ((remaining.get(ts.id) ?? 0) <= 0) continue;

		// Not at the one location this meeting may use.
		if (limits.locationId !== undefined && ts.locationId !== limits.locationId) continue;

		// Either attendee already has as many meetings at this start time as they may hold.
		if (busyCountAt(busyA, ts.startTime) >= limitA) continue;
		if (busyCountAt(busyB, ts.startTime) >= limitB) continue;

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

/** The fields of a meeting the reconciliation reads. */
type ReconcileMeeting = { attendeeA: string; attendeeB: string; timeslotId: string };

/**
 * The key reconciliation groups a meeting's time by.
 * It is the slot's start time when the slot is known.
 * A pushed meeting's slot can drop out of Cvent's list once it is full, so the slot id stands in then.
 *
 * @param {ReconcileMeeting} m - The meeting.
 * @param {Map<string, Pick<Timeslot, 'startTime'>>} timeslotById - The event's timeslots.
 * @returns {string} The time key.
 */
function reconcileTimeKey(
	m: ReconcileMeeting,
	timeslotById: Map<string, Pick<Timeslot, 'startTime'>>,
): string {
	const start = timeslotById.get(m.timeslotId)?.startTime;
	return start ? `time:${new Date(start).getTime()}` : `slot:${m.timeslotId}`;
}

/**
 * Drops fresh engine meetings that clash with meetings already pushed to Cvent.
 * A fresh meeting is dropped when its pair is already pushed.
 * It is also dropped when either party would then hold more meetings at that time than it may.
 * A delegate may hold 1 at a time, and a sponsor company up to its meetings-at-once limit.
 * Kept fresh meetings count toward the limit too, in schedule order.
 *
 * @param {M[]} schedule - The engine's fresh meetings.
 * @param {ReconcileMeeting[]} pushed - Meetings already pushed to Cvent.
 * @param {Map<string, Pick<Timeslot, 'startTime'>>} timeslotById - The event's timeslots.
 * @param {(partyId: string) => number} atOnceOf - How many meetings a party may hold at one time.
 * @returns {{ kept: M[]; droppedPairs: Set<string> }} The meetings to keep, and the pair keys of those dropped.
 */
export function reconcileWithPushed<M extends ReconcileMeeting>(
	schedule: M[],
	pushed: ReconcileMeeting[],
	timeslotById: Map<string, Pick<Timeslot, 'startTime'>>,
	atOnceOf: (partyId: string) => number,
): { kept: M[]; droppedPairs: Set<string> } {

	// Pairs already pushed, and how many meetings each party has at each time.
	const pushedPairs = new Set<string>();
	const counts = new Map<string, number>();

	/**
	 * The count key for one party at one meeting's time.
	 *
	 * @param {string} party - The party id.
	 * @param {ReconcileMeeting} m - The meeting.
	 * @returns {string} The key.
	 */
	const countKey = (party: string, m: ReconcileMeeting): string =>
		`${party}@${reconcileTimeKey(m, timeslotById)}`;

	/**
	 * Counts one more meeting for a party at a meeting's time.
	 *
	 * @param {string} party - The party id.
	 * @param {ReconcileMeeting} m - The meeting.
	 */
	const add = (party: string, m: ReconcileMeeting): void => {
		const k = countKey(party, m);
		counts.set(k, (counts.get(k) ?? 0) + 1);
	};

	for (const row of pushed) {
		pushedPairs.add(pairKey(row.attendeeA, row.attendeeB));
		add(row.attendeeA, row);
		add(row.attendeeB, row);
	}

	const kept: M[] = [];
	const droppedPairs = new Set<string>();
	for (const m of schedule) {
		const pair = pairKey(m.attendeeA, m.attendeeB);

		// Whether a party already holds as many meetings at this time as it may.
		const full = (party: string): boolean =>
			(counts.get(countKey(party, m)) ?? 0) >= atOnceOf(party);

		if (pushedPairs.has(pair) || full(m.attendeeA) || full(m.attendeeB)) {
			droppedPairs.add(pair);
			continue;
		}
		kept.push(m);
		add(m.attendeeA, m);
		add(m.attendeeB, m);
	}
	return { kept, droppedPairs };
}
