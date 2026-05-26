import fs from 'fs';
import path from 'path';
import {
	Attendee,
	AttendeeRole,
	AttendeeSchedule,
	AttendeeSlot,
	MeetingRequest,
	ScheduledMeeting,
	SponsorTier,
} from '@/types';

// ---------------------------------------------------------------------------
// JSON loaders
// ---------------------------------------------------------------------------

/**
 * Reads and parses `attendees.json` at the given path into typed `Attendee` records.
 *
 * @param {string} filePath - Absolute path to the attendees JSON file.
 * @returns {Promise<Attendee[]>} Resolves to an array of parsed `Attendee` objects.
 */
export async function loadMockData(filePath: string): Promise<Attendee[]> {

	// Read the file from disk as a UTF-8 string and parse it as JSON.
	const raw = fs.readFileSync(path.resolve(filePath), 'utf-8');
	return JSON.parse(raw) as Attendee[];
}

/**
 * Reads and parses `requests.json` at the given path into typed `MeetingRequest` records.
 *
 * @param {string} filePath - Absolute path to the meeting requests JSON file.
 * @returns {Promise<MeetingRequest[]>} Resolves to an array of parsed `MeetingRequest` objects.
 */
export async function loadMockRequests(filePath: string): Promise<MeetingRequest[]> {

	// Read the file from disk as a UTF-8 string and parse it as JSON.
	const raw = fs.readFileSync(path.resolve(filePath), 'utf-8');
	return JSON.parse(raw) as MeetingRequest[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Produces a canonical, order-independent key for a pair of attendee IDs (e.g. `"d1|s2"`).
 *
 * @param {string} a - First attendee ID.
 * @param {string} b - Second attendee ID.
 * @returns {string} A stable key regardless of argument order.
 */
function pairKey(a: string, b: string): string {

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
function findMutualSlot(
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

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

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

// Cumulative meeting caps per sponsor tier at Pass 5.
const SPONSOR_CAPS_PASS5: Record<string, number> = { diamond: 10, standard: 7 };

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
		passNumber: 3,
		day: 1,
		delegateCap: 4,
		sponsorCap: () => 6,
		filter: (req, tgt, rank, _mutual) =>
			req.role === 'delegate' && tgt.role === 'sponsor' && rank >= 4,
	},
	{
		// Pass 4: Second pass on mutual sponsor <-> delegate requests. Raises caps to fill remaining slots.
		passNumber: 4,
		day: 1,
		delegateCap: 5,
		sponsorCap: () => 8,
		filter: (req, tgt, _rank, mutual) =>
			mutual &&
			((req.role === 'sponsor' && tgt.role === 'delegate') ||
				(req.role === 'delegate' && tgt.role === 'sponsor')),
	},
	{
		// Pass 5: All remaining sponsor requests, any rank. Caps raised to fulfill package meeting guarantees.
		passNumber: 5,
		day: 1,
		delegateCap: 7,
		sponsorCap: (tier) => (tier ? (SPONSOR_CAPS_PASS5[tier] ?? 7) : 7),
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
 * each pass raises the ceiling without resetting counts. Before confirming any meeting,
 * the engine verifies that both attendees have a mutually available time slot, then marks
 * those slots as blocked so they cannot be reused. Business rules (no duplicates,
 * no self-meetings, company diversity) are enforced on every candidate.
 *
 * @param {Attendee[]} attendees - All attendees to schedule meetings for.
 * @param {MeetingRequest[]} requests - All submitted meeting requests.
 * @returns {Promise<{ schedule: ScheduledMeeting[]; attendeeSchedules: AttendeeSchedule[] }>}
 *   Resolves to the flat list of all scheduled meetings and a per-attendee breakdown.
 */
export async function runScheduler(
	attendees: Attendee[],
	requests: MeetingRequest[]
): Promise<{ schedule: ScheduledMeeting[]; attendeeSchedules: AttendeeSchedule[] }> {

	// Index attendees by ID for lookup throughout the algorithm.
	const attendeeMap = new Map(attendees.map(a => [a.id, a]));

	// Pre-compute all mutual pairs once so each pass can check mutuality cheaply.
	const mutualPairs = computeMutualPairs(requests);

	// Initialize a set to track which pairs have already been scheduled to prevent duplicates.
	const scheduledPairs = new Set<string>();

	// Create a mutable copy of each attendee's slots keyed by attendee ID.
	const slotsByAttendee = new Map<string, AttendeeSlot[]>(
		attendees.map(a => [
			a.id,
			a.scheduling.slots.map(s => ({ ...s })),
		])
	);

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

			// Derive the available slot count for each attendee on this day from the mutable slot map.
			const requesterAvailableSlots = (slotsByAttendee.get(req.requesterId) ?? [])
				.filter(s => s.day === day && s.status === 'available').length;
			const targetAvailableSlots    = (slotsByAttendee.get(req.targetId) ?? [])
				.filter(s => s.day === day && s.status === 'available').length;

			// Cap is the lower of the pass cap and the attendee's total available slots on this day.
			const requesterCap = Math.min(getCap(requester, pass), requesterAvailableSlots + requesterDayCount);
			const targetCap    = Math.min(getCap(target,    pass), targetAvailableSlots    + targetDayCount);

			// Skip if either attendee has already reached their cumulative cap for this pass.
			if (requesterDayCount >= requesterCap) continue;
			if (targetDayCount    >= targetCap)    continue;

			// Skip if this meeting would violate the company diversity rule for either attendee.
			const requesterMaxSame = requester.scheduling.maxSameCompanyMeetings ?? 2;
			const targetMaxSame    = target.scheduling.maxSameCompanyMeetings    ?? 2;
			if (wouldViolateCompanyDiversity(allMeetings, attendeeMap, req.requesterId, req.targetId, requesterMaxSame)) continue;
			if (wouldViolateCompanyDiversity(allMeetings, attendeeMap, req.targetId, req.requesterId, targetMaxSame))    continue;

			// Find a mutually available time slot for both attendees on this day.
			const requesterSlots = slotsByAttendee.get(req.requesterId) ?? [];
			const targetSlots    = slotsByAttendee.get(req.targetId)    ?? [];
			const mutualSlot     = findMutualSlot(requesterSlots, targetSlots, day);

			// Skip this pair if no overlapping available slot exists.
			if (!mutualSlot) continue;

			// Mark both matched slots as blocked so they can't be reassigned to another meeting.
			mutualSlot.slotA.status = 'blocked';
			mutualSlot.slotB.status = 'blocked';

			// Build the ScheduledMeeting record with all required fields.
			const meeting: ScheduledMeeting = {
				id: `mtg-${String(meetingCounter++).padStart(3, '0')}`,
				attendeeA: req.requesterId,
				attendeeB: req.targetId,
				day,
				slotIdA: mutualSlot.slotA.slotId,
				slotIdB: mutualSlot.slotB.slotId,
				passNumber: pass.passNumber,
				mutual: isMutual,
				startTime: mutualSlot.slotA.startTime,
				endTime: mutualSlot.slotA.endTime,
				cventAppointmentId: null,
			};

			// Add the meeting to the master schedule.
			allMeetings.push(meeting);

			// Mark this pair as done so no later pass attempts to schedule them again.
			scheduledPairs.add(key);
		}
	}

	// Build a per-attendee view of the schedule by filtering the full meeting list.
	const attendeeSchedules: AttendeeSchedule[] = attendees.map(a => ({
		attendeeId: a.id,
		name: a.name,
		company: a.company,
		role: a.role as AttendeeRole,
		day1Meetings: allMeetings
			.filter(m => m.day === 1 && (m.attendeeA === a.id || m.attendeeB === a.id))
			.sort((a, b) => a.startTime!.localeCompare(b.startTime!)),
		day2Meetings: allMeetings
			.filter(m => m.day === 2 && (m.attendeeA === a.id || m.attendeeB === a.id))
			.sort((a, b) => a.startTime!.localeCompare(b.startTime!)),
	}));

	return { schedule: allMeetings, attendeeSchedules };
}
