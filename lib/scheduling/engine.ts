import {
    Attendee,
    AttendeeRole,
    AttendeeSchedule,
    Location,
    MeetingRequest,
    ScheduledMeeting,
    SponsorTier,
    Timeslot,
} from "@/types";
import {
    pairKey,
    computeMutualPairs,
    findAvailableTimeslot,
    withDelegatePreferences,
    wouldViolateCompanyDiversity,
} from "./helpers";
import type { SchedulerFailureReason } from "./report";
import {
    partyId,
    sponsorCompaniesByAccountId,
} from "@/lib/attendees/companies";

/**
 * A single scheduling entity: one party in the algorithm. For sponsors this is
 * a whole COMPANY (all reps combined, keyed by the shared Account id); for
 * delegates it's the individual. The engine keys every structure by `partyId`
 * so a company is scheduled as one unit with a shared budget and combined
 * schedule.
 */
interface SchedEntity {
    /** The party id: Account id for a sponsor company, salesforceId for a delegate. */
    partyId: string;
    role: AttendeeRole;
    /** Company-resolved tier (highest of the reps) for sponsors; null for delegates. */
    tier: SponsorTier;
    /** Same-company diversity key: the account id (sponsors) or the delegate's employer account/company. */
    companyKey: string;
    /** Delegate-only diversity cap; null for sponsor companies (rule N/A). */
    maxSameCompanyMeetings: number | null;
    /** Display name (company name for sponsors, person name for delegates). */
    name: string;
    /** Display company name. */
    company: string;
}

// Defines the configuration for each pass of the scheduling algorithm, including caps and filters.
interface PassConfig {
    passNumber: number;
    day: 1 | 2;
    delegateCap: number;
    sponsorCap: (tier: SponsorTier) => number;
    // Filters read only the party's role, so they accept the lighter entity
    // shape (a company on the sponsor side, an individual on the delegate side).
    filter: (
        requester: { role: AttendeeRole },
        target: { role: AttendeeRole },
        rank: number,
        isMutual: boolean,
    ) => boolean;
}

// Cumulative meeting caps per sponsor tier, matched to contracted package counts.
// Diamond: 8 contracted. Standard: 5 contracted.
// These caps apply from pass 3 onward; earlier passes use lower shared ceilings.
const SPONSOR_CAPS: Record<
    string,
    { pass3: number; pass4: number; pass5: number }
> = {
    diamond: { pass3: 6, pass4: 8, pass5: 8 },
    standard: { pass3: 5, pass4: 5, pass5: 5 },
};

const tierCap = (
    tier: SponsorTier,
    key: keyof (typeof SPONSOR_CAPS)["diamond"],
) => (tier ? (SPONSOR_CAPS[tier]?.[key] ?? 5) : 5);

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
            ((req.role === "sponsor" && tgt.role === "delegate") ||
                (req.role === "delegate" && tgt.role === "sponsor")),
    },
    {
        // Pass 2: High-interest sponsor requests (rank >= 4), regardless of mutuality.
        passNumber: 2,
        day: 1,
        delegateCap: 3,
        sponsorCap: () => 4,
        filter: (req, tgt, rank, _mutual) =>
            req.role === "sponsor" && tgt.role === "delegate" && rank >= 4,
    },
    {
        // Pass 3: High-interest delegate requests for sponsors (rank >= 4), regardless of mutuality.
        // Cap is now tier-aware: standard sponsors are held to their contracted limit (5).
        passNumber: 3,
        day: 1,
        delegateCap: 4,
        sponsorCap: (tier) => tierCap(tier, "pass3"),
        filter: (req, tgt, rank, _mutual) =>
            req.role === "delegate" && tgt.role === "sponsor" && rank >= 4,
    },
    {
        // Pass 4: Second pass on mutual sponsor <-> delegate requests. Raises caps to fill remaining slots.
        // Cap is tier-aware: standard stays at 5, diamond rises to 8.
        passNumber: 4,
        day: 1,
        delegateCap: 5,
        sponsorCap: (tier) => tierCap(tier, "pass4"),
        filter: (req, tgt, _rank, mutual) =>
            mutual &&
            ((req.role === "sponsor" && tgt.role === "delegate") ||
                (req.role === "delegate" && tgt.role === "sponsor")),
    },
    {
        // Pass 5: All remaining sponsor requests, any rank. Final cap matches contracted package counts.
        // TODO: Replace hardcoded pass5 caps with contracted + bonus once the bonus field is
        // available from Salesforce. The tierCap lookup will need to accept a dynamic value
        // per attendee rather than a fixed tier-based constant.
        passNumber: 5,
        day: 1,
        delegateCap: 7,
        sponsorCap: (tier) => tierCap(tier, "pass5"),
        filter: (req, tgt, _rank, _mutual) =>
            req.role === "sponsor" && tgt.role === "delegate",
    },
    {
        // Pass 6: Mutual delegate <-> delegate requests on Day 2 only.
        passNumber: 6,
        day: 2,
        delegateCap: 2,
        sponsorCap: () => 0,
        filter: (req, tgt, _rank, mutual) =>
            mutual && req.role === "delegate" && tgt.role === "delegate",
    },
    {
        // Pass 7: All remaining delegate <-> delegate requests on Day 2, any rank.
        passNumber: 7,
        day: 2,
        delegateCap: 2,
        sponsorCap: () => 0,
        filter: (req, tgt, _rank, _mutual) =>
            req.role === "delegate" && tgt.role === "delegate",
    },
];

/**
 * Returns the cumulative meeting cap for a party under a given pass. For a
 * sponsor company the tier is the company-resolved tier, so the cap is a single
 * budget shared across all the company's reps (all its meetings carry the same
 * account id on attendeeA, so counting by that id counts the whole company).
 *
 * @param {SchedEntity} entity - The party whose cap is being looked up.
 * @param {PassConfig} pass - The current pass configuration.
 * @returns {number} The maximum total meetings allowed for this party by the end of this pass.
 */
function getCap(entity: SchedEntity, pass: PassConfig): number {
    // Sponsors and delegates use separate cap functions per pass.
    return entity.role === "sponsor"
        ? pass.sponsorCap(entity.tier)
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
    day: 1 | 2,
): number {
    return meetings.filter(
        (m) =>
            m.day === day &&
            (m.attendeeA === attendeeId || m.attendeeB === attendeeId),
    ).length;
}

/**
 * Meetings that already exist in Cvent, used to make the engine schedule around
 * them rather than generate conflicts.
 */
export interface PreexistingSchedule {
	/** Canonical pair keys (see pairKey) that already meet in Cvent, keyed by party id. */
	pairs?: Set<string>;
	/** Per-party (party id) set of ISO start times already booked in Cvent. For a
	 *  sponsor company this is the union of all its reps' booked times. */
	busyStartTimesByAttendee?: Map<string, Set<string>>;
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
 * The engine avoids conflicting with meetings that already exist in Cvent when
 * the caller passes `preexisting`: those pairs are treated as already scheduled
 * and those attendee/time combinations as already busy, so the engine never
 * generates a duplicate pairing or double-books someone against a Cvent booking.
 * Callers still run post-reconciliation for anything not covered here.
 *
 * Delegates express their side of the request graph on the event's intake form
 * rather than in the portal, so `requests` is widened here with one
 * delegate→sponsor request per entry in each delegate's
 * `scheduling.requestedSponsorAccountIds`. Everything downstream — mutuality,
 * the pass filters, candidate ordering — then treats both sides identically. The
 * widened list comes back as `effectiveRequests` so the run report tallies
 * exactly what the engine considered.
 *
 * @param {Attendee[]} attendees - All attendees to schedule meetings for.
 * @param {MeetingRequest[]} requests - Meeting requests submitted through the portal.
 * @param {Timeslot[]} timeslots - The event's global, Cvent-sourced timeslots.
 * @param {Location[]} _locations - The event's locations (reserved for future location-aware assignment).
 * @param {PreexistingSchedule} [preexisting] - Pairs/times already booked in Cvent to schedule around.
 * @returns {Promise<{ schedule: ScheduledMeeting[]; attendeeSchedules: AttendeeSchedule[]; skipReasons: Map<string, SchedulerFailureReason>; effectiveRequests: MeetingRequest[] }>}
 *   Resolves to the flat list of newly scheduled meetings, a per-attendee
 *   breakdown, — for the run report — why each attempted-but-unscheduled
 *   pair was skipped, keyed by canonical pairKey, and the full request list the
 *   run actually considered (portal requests plus derived delegate preferences).
 */
export async function runScheduler(
	attendees: Attendee[],
	requests: MeetingRequest[],
	timeslots: Timeslot[],
	_locations: Location[],
	preexisting: PreexistingSchedule = {},
): Promise<{
	schedule: ScheduledMeeting[];
	attendeeSchedules: AttendeeSchedule[];
	skipReasons: Map<string, SchedulerFailureReason>;
	effectiveRequests: MeetingRequest[];
}> {

	// Fold each delegate's intake-form "sponsors I want to meet" answers into the
	// request list, so the delegate side of every pairing is a first-class
	// request from here on. Done once, up front — every structure below reads
	// from this list.
	const effectiveRequests = withDelegatePreferences(requests, attendees);

	// Group sponsors into companies (one scheduling unit per Account id, reps
	// combined) — the single place company grouping is derived.
	const companies = sponsorCompaniesByAccountId(attendees);

	// Build one scheduling entity per PARTY, keyed by party id: a company for
	// each sponsor account, an individual for each delegate. This replaces the
	// old per-rep attendee index so the whole algorithm keys by party id.
	const entityByParty = new Map<string, SchedEntity>();
	for (const c of companies.values()) {
		entityByParty.set(c.accountId, {
			partyId: c.accountId,
			role: "sponsor",
			tier: c.tier,
			companyKey: c.accountId,
			maxSameCompanyMeetings: null,
			name: c.name,
			company: c.name,
		});
	}
	for (const a of attendees) {
		if (a.role === "sponsor") continue;
		entityByParty.set(a.salesforceId, {
			partyId: a.salesforceId,
			role: "delegate",
			tier: null,
			companyKey: a.accountId || a.company,
			maxSameCompanyMeetings: a.scheduling.maxSameCompanyMeetings,
			name: a.name,
			company: a.company,
		});
	}

	// Normalize any id found on a request (a rep's salesforceId, an account id,
	// or a delegate's salesforceId) to its party id, so requests keyed by an
	// individual rep still collapse onto that rep's company.
	const partyIdByAnyId = new Map<string, string>();
	for (const a of attendees) partyIdByAnyId.set(a.salesforceId, partyId(a));
	for (const c of companies.values()) partyIdByAnyId.set(c.accountId, c.accountId);
	const norm = (id: string): string => partyIdByAnyId.get(id) ?? id;

	// Index timeslots by id for resolving booked times when sorting schedules.
	const timeslotById = new Map(timeslots.map(t => [t.id, t]));

	// Pre-compute all mutual pairs once so each pass can check mutuality cheaply.
	// Requests are normalized to party ids first so a mutual pair between a
	// company and a delegate is detected regardless of which rep requested.
	const mutualPairs = computeMutualPairs(
		effectiveRequests.map(r => ({ ...r, requesterId: norm(r.requesterId), targetId: norm(r.targetId) })),
	);

	// Track which pairs are already scheduled (to prevent duplicates), seeded with
	// pairs that already meet in Cvent so the engine won't re-create them.
	const scheduledPairs = new Set<string>(preexisting.pairs);

	// Per-party set of start times already booked, so no party is double-booked
	// at the same wall-clock time. Keyed by party id and seeded from Cvent (a
	// company's set is the union of all its reps' booked times — see
	// buildPreexistingFromCvent).
	const busyByAttendee = new Map<string, Set<string>>(
		[...entityByParty.keys()].map(pid => [
			pid,
			new Set<string>(preexisting.busyStartTimesByAttendee?.get(pid)),
		])
	);

	// Remaining capacity per timeslot id, drawn down as meetings are booked.
	const timeslotRemaining = new Map(timeslots.map(t => [t.id, t.capacity]));

	// Initialize the master list of all scheduled meetings.
	const allMeetings: ScheduledMeeting[] = [];

	// Auto-increment counter for generating unique meeting IDs.
	let meetingCounter = 1;

	// Records why each attempted pair was skipped, keyed by canonical pairKey.
	// The run report uses this to explain unscheduled requests. Later passes
	// overwrite earlier ones so the most-progressed reason wins.
	const skipReasons = new Map<string, SchedulerFailureReason>();

	// Loop through each pass in order, applying its specific filters and caps.
	for (const pass of PASSES) {

		// Collect every request that is eligible to be scheduled in this pass.
		const candidates: Array<{ req: MeetingRequest; isMutual: boolean }> = [];

		// Loop through all requests to find candidates for this pass.
		for (const req of effectiveRequests) {

			// Resolve both sides to party ids (company for sponsor reps).
			const requesterParty = norm(req.requesterId);
			const targetParty = norm(req.targetId);

			// Get the requester and target scheduling entities for this request.
			const requester = entityByParty.get(requesterParty);
			const target = entityByParty.get(targetParty);

			// Skip if either party isn't in the entity list.
			if (!requester || !target) continue;

			// Skip self-requests (e.g. a rep of a company requesting the company).
			if (requesterParty === targetParty) continue;

			// Skip pairs already scheduled in a previous pass.
			if (scheduledPairs.has(pairKey(requesterParty, targetParty))) continue;

			// Check whether this pair is mutual.
			const isMutual = mutualPairs.has(pairKey(requesterParty, targetParty));

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

			// Party ids for both sides (company for sponsor reps).
			const requesterParty = norm(req.requesterId);
			const targetParty = norm(req.targetId);

			const key = pairKey(requesterParty, targetParty);

			// Check again in case a higher-priority candidate in this same pass claimed this pair.
			if (scheduledPairs.has(key)) continue;

			// Get the requester and target scheduling entities again for this request.
			const requester = entityByParty.get(requesterParty)!;
			const target = entityByParty.get(targetParty)!;
			const day = pass.day;

			// Count how many meetings each party already has on this day.
			const requesterDayCount = countMeetingsOnDay(allMeetings, requesterParty, day);
			const targetDayCount    = countMeetingsOnDay(allMeetings, targetParty,    day);

			// Busy-time sets for each party, used to find a free timeslot below.
			const requesterBusy = busyByAttendee.get(requesterParty) ?? new Set<string>();
			const targetBusy    = busyByAttendee.get(targetParty)    ?? new Set<string>();

			// Skip if either party has already reached the POLICY cap for this pass.
			//
			// Deliberately the pass cap alone. This check used to also fold in how
			// many timeslots the party could still reach
			// (`min(passCap, available + dayCount)`), which meant an event that had
			// simply run out of appointment capacity reported every remaining pair
			// as "cap_reached" — even a party with zero meetings, since the cap
			// collapsed to its own meeting count and `0 >= 0` holds. Running out of
			// room is a different problem from hitting a contractual limit, and the
			// run report is the only place an admin sees the difference.
			//
			// Nothing is lost by dropping the availability term: findAvailableTimeslot
			// below rejects exactly the same pairs, and labels them "no_availability".
			if (requesterDayCount >= getCap(requester, pass)) { skipReasons.set(key, "cap_reached"); continue; }
			if (targetDayCount    >= getCap(target,    pass)) { skipReasons.set(key, "cap_reached"); continue; }

			// Skip if this meeting would violate the company diversity rule for either party.
			const requesterMaxSame = requester.maxSameCompanyMeetings ?? 2;
			const targetMaxSame    = target.maxSameCompanyMeetings    ?? 2;
			if (wouldViolateCompanyDiversity(allMeetings, entityByParty, requesterParty, targetParty, requesterMaxSame)) { skipReasons.set(key, "company_diversity"); continue; }
			if (wouldViolateCompanyDiversity(allMeetings, entityByParty, targetParty, requesterParty, targetMaxSame))    { skipReasons.set(key, "company_diversity"); continue; }

			// Find a timeslot on this day where both attendees are free and capacity remains.
			const timeslot = findAvailableTimeslot(timeslots, day, requesterBusy, targetBusy, timeslotRemaining);

			// Skip this pair if no usable timeslot exists — the event is out of
			// appointment capacity for this day, or one of the two is already
			// booked at every remaining start time.
			if (!timeslot) { skipReasons.set(key, "no_availability"); continue; }

			// Book the timeslot: mark both attendees busy at its start time and draw down capacity.
			requesterBusy.add(timeslot.startTime);
			targetBusy.add(timeslot.startTime);
			timeslotRemaining.set(timeslot.id, (timeslotRemaining.get(timeslot.id) ?? 0) - 1);

			// Storage orientation is CANONICAL, not request direction: on a
			// sponsor↔delegate meeting the sponsor company is always attendeeA.
			// Readers depend on it to find a company's meetings and to resolve
			// appointment hosts — see ScheduledMeeting's field docs, the
			// per-sponsor admin page, and lib/cvent/push.ts.
			//
			// It used to hold for free, because the requester of a sponsor↔delegate
			// pairing was always the sponsor. Delegates became requesters too once
			// their intake-form preferences started being folded in as requests
			// (see withDelegatePreferences), so the orientation has to be made
			// explicit here. matchKind below still records who actually asked.
			const delegateInitiated =
				requester.role === 'delegate' && target.role === 'sponsor';
			const attendeeA = delegateInitiated ? targetParty : requesterParty;
			const attendeeB = delegateInitiated ? requesterParty : targetParty;

			// Build the ScheduledMeeting record with all required fields. Location defaults
			// to the timeslot's native Cvent location; an admin can reassign it later.
			// A timestamp suffix keeps ids unique across scheduler runs, since Cvent
			// never frees an appointment's code even after it's cancelled, so a
			// counter that restarts from 1 each run could otherwise reuse an id
			// still attached to an old, deleted-but-cancelled Cvent appointment.
			const meeting: ScheduledMeeting = {
				id: `mtg-${String(meetingCounter++).padStart(3, '0')}-${Date.now()}`,
				attendeeA,
				attendeeB,
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

	// Build a per-PARTY view from all meetings for a complete picture. Keyed by
	// party id (company for sponsors), matching how meetings store attendeeA/B —
	// so a company shows one combined schedule rather than each rep showing an
	// empty one.
	const attendeeSchedules: AttendeeSchedule[] = [...entityByParty.values()].map(e => ({
		attendeeId: e.partyId,
		name: e.name,
		company: e.company,
		role: e.role,
		day1Meetings: allMeetings
			.filter(m => m.day === 1 && (m.attendeeA === e.partyId || m.attendeeB === e.partyId))
			.sort((x, y) => startTimeOf(x).localeCompare(startTimeOf(y))),
		day2Meetings: allMeetings
			.filter(m => m.day === 2 && (m.attendeeA === e.partyId || m.attendeeB === e.partyId))
			.sort((x, y) => startTimeOf(x).localeCompare(startTimeOf(y))),
	}));

	return { schedule: allMeetings, attendeeSchedules, skipReasons, effectiveRequests };
}
