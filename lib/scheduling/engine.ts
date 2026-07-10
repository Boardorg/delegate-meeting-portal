import {
	Attendee,
	AttendeeRole,
	AttendeeSchedule,
	Location,
	MeetingRequest,
	ScheduledMeeting,
	SponsorTier,
	Timeslot,
} from '@/types';
import { pairKey, computeMutualPairs, findAvailableTimeslot, wouldViolateCompanyDiversity } from './helpers';

// Defines the configuration for each pass of the scheduling algorithm, including caps and filters.
interface PassConfig {
	passNumber: number;
	day: 1 | 2;
	delegateCap: number;
	sponsorCap: (tier: SponsorTier) => number;
	filter: (
		requester: Attendee,
		target: Attendee,
		rank: number,
		isMutual: boolean
	) => boolean;
}

// Cumulative meeting caps per sponsor tier, matched to contracted package counts.
// Diamond: 8 contracted. Standard: 5 contracted.
// These caps apply from pass 3 onward; earlier passes use lower shared ceilings.
const SPONSOR_CAPS: Record<string, { pass3: number; pass4: number; pass5: number }> = {
	diamond:  { pass3: 6, pass4: 8, pass5: 8 },
	standard: { pass3: 5, pass4: 5, pass5: 5 },
};

const tierCap = (tier: SponsorTier, key: keyof typeof SPONSOR_CAPS['diamond']) =>
	tier ? (SPONSOR_CAPS[tier]?.[key] ?? 5) : 5;

// Defines the seven passes of the scheduling algorithm with their specific rules and caps.
const PASSES: PassConfig[] = [
	{
		// Pass 1: Mutual sponsor <-> delegate requests only. Both parties requested each other.
		passNumber: 1,
		day: 1,
		delegateCap: 2,
		sponsorCap: () => 3,
		filter: (req, tgt, _rank, mutual) =>
			mutual &&
			((req.role === 'sponsor' && tgt.role === 'delegate') ||
				(req.role === 'delegate' && tgt.role === 'sponsor')),
	},
	{
		// Pass 2: High-interest sponsor requests (rank >= 4), regardless of mutuality.
		passNumber: 2,
		day: 1,
		delegateCap: 3,
		sponsorCap: () => 4,
		filter: (req, tgt, rank, _mutual) =>
			req.role === 'sponsor' && tgt.role === 'delegate' && rank >= 4,
	},
	{
		// Pass 3: High-interest delegate requests for sponsors (rank >= 4), regardless of mutuality.
		// Cap is now tier-aware: standard sponsors are held to their contracted limit (5).
		passNumber: 3,
		day: 1,
		delegateCap: 4,
		sponsorCap: (tier) => tierCap(tier, 'pass3'),
		filter: (req, tgt, rank, _mutual) =>
			req.role === 'delegate' && tgt.role === 'sponsor' && rank >= 4,
	},
	{
		// Pass 4: Second pass on mutual sponsor <-> delegate requests. Raises caps to fill remaining slots.
		// Cap is tier-aware: standard stays at 5, diamond rises to 8.
		passNumber: 4,
		day: 1,
		delegateCap: 5,
		sponsorCap: (tier) => tierCap(tier, 'pass4'),
		filter: (req, tgt, _rank, mutual) =>
			mutual &&
			((req.role === 'sponsor' && tgt.role === 'delegate') ||
				(req.role === 'delegate' && tgt.role === 'sponsor')),
	},
	{
		// Pass 5: All remaining sponsor requests, any rank. Final cap matches contracted package counts.
		// TODO: Replace hardcoded pass5 caps with contracted + bonus once the bonus field is
		// available from Salesforce. The tierCap lookup will need to accept a dynamic value
		// per attendee rather than a fixed tier-based constant.
		passNumber: 5,
		day: 1,
		delegateCap: 7,
		sponsorCap: (tier) => tierCap(tier, 'pass5'),
		filter: (req, tgt, _rank, _mutual) =>
			req.role === 'sponsor' && tgt.role === 'delegate',
	},
	{
		// Pass 6: Mutual delegate <-> delegate requests on Day 2 only.
		passNumber: 6,
		day: 2,
		delegateCap: 2,
		sponsorCap: () => 0,
		filter: (req, tgt, _rank, mutual) =>
			mutual && req.role === 'delegate' && tgt.role === 'delegate',
	},
	{
		// Pass 7: All remaining delegate <-> delegate requests on Day 2, any rank.
		passNumber: 7,
		day: 2,
		delegateCap: 2,
		sponsorCap: () => 0,
		filter: (req, tgt, _rank, _mutual) =>
			req.role === 'delegate' && tgt.role === 'delegate',
	},
];

/**
 * Returns the cumulative meeting cap for an attendee under a given pass configuration.
 *
 * @param {Attendee} attendee - The attendee whose cap is being looked up.
 * @param {PassConfig} pass - The current pass configuration.
 * @returns {number} The maximum total meetings allowed for this attendee by the end of this pass.
 */
function getCap(attendee: Attendee, pass: PassConfig): number {

	// Sponsors and delegates use separate cap functions per pass.
	return attendee.role === 'sponsor'
		? pass.sponsorCap(attendee.sponsorTier)
		: pass.delegateCap;
}

/**
 * Counts how many meetings an attendee currently has scheduled on a specific day.
 *
 * @param {ScheduledMeeting[]} meetings - All meetings scheduled so far.
 * @param {string} attendeeId - The attendee to count for.
 * @param {1 | 2} day - The event day to count on.
 * @returns {number} The number of meetings this attendee has on that day.
 */
function countMeetingsOnDay(
	meetings: ScheduledMeeting[],
	attendeeId: string,
	day: 1 | 2
): number {
	return meetings.filter(
		m => m.day === day && (m.attendeeA === attendeeId || m.attendeeB === attendeeId)
	).length;
}

/**
 * Runs the full multi-pass scheduling algorithm against a set of attendees and requests.
 *
 * Meetings are scheduled across seven passes in priority order. Caps are cumulative —
 * each pass raises the ceiling without resetting counts. Availability is event-global:
 * before confirming any meeting, the engine finds a timeslot where both attendees are
 * free and capacity remains, then marks them busy at that time and decrements the
 * timeslot's remaining capacity. Each meeting's location defaults to the booked
 * timeslot's native Cvent location. Business rules (no duplicates, no self-meetings,
 * company diversity) are enforced on every candidate.
 *
 * The engine runs freely with no knowledge of previously pushed meetings. Callers are
 * responsible for post-reconciliation: drop any fresh meeting that duplicates or conflicts
 * with a pushed meeting before inserting into the DB.
 *
 * @param {Attendee[]} attendees - All attendees to schedule meetings for.
 * @param {MeetingRequest[]} requests - All submitted meeting requests.
 * @param {Timeslot[]} timeslots - The event's global, Cvent-sourced timeslots.
 * @param {Location[]} _locations - The event's locations (reserved for future location-aware assignment).
 * @returns {Promise<{ schedule: ScheduledMeeting[]; attendeeSchedules: AttendeeSchedule[] }>}
 *   Resolves to the flat list of newly scheduled meetings and a per-attendee breakdown.
 */
export async function runScheduler(
	attendees: Attendee[],
	requests: MeetingRequest[],
	timeslots: Timeslot[],
	_locations: Location[],
): Promise<{ schedule: ScheduledMeeting[]; attendeeSchedules: AttendeeSchedule[] }> {

	// Index attendees by Salesforce ID for lookup throughout the algorithm.
	const attendeeMap = new Map(attendees.map(a => [a.salesforceId, a]));

	// Index timeslots by id for resolving booked times when sorting schedules.
	const timeslotById = new Map(timeslots.map(t => [t.id, t]));

	// Pre-compute all mutual pairs once so each pass can check mutuality cheaply.
	const mutualPairs = computeMutualPairs(requests);

	// Initialize a set to track which pairs have already been scheduled to prevent duplicates.
	const scheduledPairs = new Set<string>();

	// Per-attendee set of start times already booked, so nobody is double-booked
	// at the same wall-clock time. Keyed by Salesforce ID.
	const busyByAttendee = new Map<string, Set<string>>(
		attendees.map(a => [a.salesforceId, new Set<string>()])
	);

	// Remaining capacity per timeslot id, drawn down as meetings are booked.
	const timeslotRemaining = new Map(timeslots.map(t => [t.id, t.capacity]));

	// Initialize the master list of all scheduled meetings.
	const allMeetings: ScheduledMeeting[] = [];

	// Auto-increment counter for generating unique meeting IDs.
	let meetingCounter = 1;

	// Loop through each pass in order, applying its specific filters and caps.
	for (const pass of PASSES) {

		// Collect every request that is eligible to be scheduled in this pass.
		const candidates: Array<{ req: MeetingRequest; isMutual: boolean }> = [];

		// Loop through all requests to find candidates for this pass.
		for (const req of requests) {

			// Get the requester and target Attendee objects for this request.
			const requester = attendeeMap.get(req.requesterId);
			const target = attendeeMap.get(req.targetId);

			// Skip if either party isn't in the attendee list.
			if (!requester || !target) continue;

			// Skip self-requests.
			if (req.requesterId === req.targetId) continue;

			// Skip pairs already scheduled in a previous pass.
			if (scheduledPairs.has(pairKey(req.requesterId, req.targetId))) continue;

			// Check whether this pair is mutual.
			const isMutual = mutualPairs.has(pairKey(req.requesterId, req.targetId));

			// Apply this pass's eligibility filter.
			if (!pass.filter(requester, target, req.rank, isMutual)) continue;

			// If we passed all the checks, this request is a candidate for scheduling in this pass.
			candidates.push({ req, isMutual });
		}

		// Sort candidates: highest rank first, mutual requests win ties, then alphabetically by target ID.
		candidates.sort((a, b) => {
			if (b.req.rank !== a.req.rank) return b.req.rank - a.req.rank;
			if (a.isMutual !== b.isMutual) return a.isMutual ? -1 : 1;
			return a.req.targetId.localeCompare(b.req.targetId);
		});

		// Attempt to schedule each candidate in sorted priority order.
		for (const { req, isMutual } of candidates) {

			const key = pairKey(req.requesterId, req.targetId);

			// Check again in case a higher-priority candidate in this same pass claimed this pair.
			if (scheduledPairs.has(key)) continue;

			// Get the requester and target Attendee objects again for this request.
			const requester = attendeeMap.get(req.requesterId)!;
			const target = attendeeMap.get(req.targetId)!;
			const day = pass.day;

			// Count how many meetings each attendee already has on this day.
			const requesterDayCount = countMeetingsOnDay(allMeetings, req.requesterId, day);
			const targetDayCount    = countMeetingsOnDay(allMeetings, req.targetId,    day);

			// Busy-time sets for each attendee, used both to count remaining availability
			// and to find a free timeslot below.
			const requesterBusy = busyByAttendee.get(req.requesterId) ?? new Set<string>();
			const targetBusy    = busyByAttendee.get(req.targetId)    ?? new Set<string>();

			// Count timeslots on this day that the attendee is still free for and that
			// have capacity left. Bounds the cap to realistic availability.
			const countAvailable = (busy: Set<string>) =>
				timeslots.filter(t =>
					t.day === day &&
					!busy.has(t.startTime) &&
					(timeslotRemaining.get(t.id) ?? 0) > 0
				).length;

			// Cap is the lower of the pass cap and the attendee's reachable availability on this day.
			const requesterCap = Math.min(getCap(requester, pass), countAvailable(requesterBusy) + requesterDayCount);
			const targetCap    = Math.min(getCap(target,    pass), countAvailable(targetBusy)    + targetDayCount);

			// Skip if either attendee has already reached their cumulative cap for this pass.
			if (requesterDayCount >= requesterCap) continue;
			if (targetDayCount    >= targetCap)    continue;

			// Skip if this meeting would violate the company diversity rule for either attendee.
			const requesterMaxSame = requester.scheduling.maxSameCompanyMeetings ?? 2;
			const targetMaxSame    = target.scheduling.maxSameCompanyMeetings    ?? 2;
			if (wouldViolateCompanyDiversity(allMeetings, attendeeMap, req.requesterId, req.targetId, requesterMaxSame)) continue;
			if (wouldViolateCompanyDiversity(allMeetings, attendeeMap, req.targetId, req.requesterId, targetMaxSame))    continue;

			// Find a timeslot on this day where both attendees are free and capacity remains.
			const timeslot = findAvailableTimeslot(timeslots, day, requesterBusy, targetBusy, timeslotRemaining);

			// Skip this pair if no usable timeslot exists.
			if (!timeslot) continue;

			// Book the timeslot: mark both attendees busy at its start time and draw down capacity.
			requesterBusy.add(timeslot.startTime);
			targetBusy.add(timeslot.startTime);
			timeslotRemaining.set(timeslot.id, (timeslotRemaining.get(timeslot.id) ?? 0) - 1);

			// Build the ScheduledMeeting record with all required fields. Location defaults
			// to the timeslot's native Cvent location; an admin can reassign it later.
			const meeting: ScheduledMeeting = {
				id: `mtg-${String(meetingCounter++).padStart(3, '0')}`,
				attendeeA: req.requesterId,
				attendeeB: req.targetId,
				day,
				timeslotId: timeslot.id,
				passNumber: pass.passNumber,
				mutual: isMutual,
				matchKind: isMutual ? 'mutual' : requester.role === 'sponsor' ? 'sponsor_choice' : 'delegate_choice',
				rank: req.rank,
				source: 'portal',
				locationId: timeslot.locationId,
				cventAppointmentId: null,
				lastModifiedAt: null,
				lastPushedAt: null,
			};

			// Add the meeting to the master schedule.
			allMeetings.push(meeting);

			// Mark this pair as done so no later pass attempts to schedule them again.
			scheduledPairs.add(key);
		}
	}

	// Resolve a meeting's start time from its booked timeslot, for ordering.
	const startTimeOf = (m: ScheduledMeeting) =>
		timeslotById.get(m.timeslotId)?.startTime ?? '';

	// Build a per-attendee view from all meetings for a complete picture.
	const attendeeSchedules: AttendeeSchedule[] = attendees.map(a => ({
		attendeeId: a.salesforceId,
		name: a.name,
		company: a.company,
		role: a.role as AttendeeRole,
		day1Meetings: allMeetings
			.filter(m => m.day === 1 && (m.attendeeA === a.salesforceId || m.attendeeB === a.salesforceId))
			.sort((x, y) => startTimeOf(x).localeCompare(startTimeOf(y))),
		day2Meetings: allMeetings
			.filter(m => m.day === 2 && (m.attendeeA === a.salesforceId || m.attendeeB === a.salesforceId))
			.sort((x, y) => startTimeOf(x).localeCompare(startTimeOf(y))),
	}));

	return { schedule: allMeetings, attendeeSchedules };
}
