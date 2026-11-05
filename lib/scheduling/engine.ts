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
    type BusyTimes,
    slotRoomKey,
    type SlotLimits,
} from "./helpers";
import type { SchedulerFailureReason } from "./report";
import {
    hostingReps,
    partyId,
    sponsorCompaniesByAccountId,
} from "@/lib/attendees/companies";
import {
    companyMaximumMeetings,
    companyMeetingsAtOnce,
} from "@/lib/attendees/caps";
import { primaryBoothProblem, type CompanyBooth } from "./booths";
import type { MeetingKind } from "@/lib/events/meetingKinds";

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
    /** The sponsor company's meeting maximum (see companyMaximumMeetings). 0 for delegates. */
    maximum: number;
    /** How many meetings the party may hold at the same start time. A delegate holds 1. */
    atOnce: number;
    /**
     * The only location a sponsor company may meet at, its booth.
     * Undefined when no booth rule applies, which is always the case for delegates.
     */
    boothLocationId?: string;
    /** Why a sponsor company can't have meetings at all. Null when it can. */
    blockedReason: SchedulerFailureReason | null;
    /** Cvent contact ids of the sponsor company's reps who can host. Empty for delegates. */
    hostContactIds: string[];
    /**
     * The sponsor company's appointments already in Cvent, pushed portal meetings included.
     * They count toward its meeting maximum before the run books anything. 0 for delegates.
     */
    existingMeetings: number;
}

// Defines the configuration for each pass of the scheduling algorithm, including caps and filters.
interface PassConfig {
    passNumber: number;
    day: 1 | 2;
    // The meeting kind this pass books. It only uses timeslots mapped to this kind.
    kind: MeetingKind;
    // A day a diamond sponsor's pair may fall back to when no slot on `day` works.
    // Unset for passes with no fallback.
    diamondSpilloverDay?: 1 | 2;
    delegateCap: number;
    // The sponsor company's cap for this pass, from its meeting maximum.
    sponsorCap: (maximum: number) => number;
    // Filters read only the party's role, so they accept the lighter entity
    // shape (a company on the sponsor side, an individual on the delegate side).
    filter: (
        requester: { role: AttendeeRole },
        target: { role: AttendeeRole },
        rank: number,
        isMutual: boolean,
    ) => boolean;
}

/**
 * The share of a sponsor company's maximum that passes 1 to 5 allow, cumulatively.
 * Each is a fraction [numerator, denominator], so the caps are exact.
 * A maximum of 8 gives 3, 4, 6, 8, 8.
 */
export const SPONSOR_PASS_SHARES: Record<1 | 2 | 3 | 4 | 5, [number, number]> = {
    1: [3, 8],
    2: [1, 2],
    3: [3, 4],
    4: [1, 1],
    5: [1, 1],
};

/**
 * A sponsor company's cumulative cap for one pass, as a share of its maximum.
 * The share rounds up, and is at least 1 when the maximum is above 0.
 * A maximum of 0 or less gives 0.
 *
 * @param {number} maximum - The company's meeting maximum.
 * @param {[number, number]} share - The pass's share, as [numerator, denominator].
 * @returns {number} The cap.
 */
export function sponsorPassCap(
    maximum: number,
    share: [number, number],
): number {
    if (maximum <= 0) return 0;
    const [num, den] = share;
    return Math.max(1, Math.ceil((maximum * num) / den));
}

// Defines the seven passes of the scheduling algorithm with their specific rules and caps.
const PASSES: PassConfig[] = [
    {
        // Pass 1: Mutual sponsor <-> delegate requests only. Both parties requested each other.
        // The sponsor cap is 37.5% of the company's maximum.
        passNumber: 1,
        day: 1,
        kind: "sponsor_delegate",
        diamondSpilloverDay: 2,
        delegateCap: 2,
        sponsorCap: (max) => sponsorPassCap(max, SPONSOR_PASS_SHARES[1]),
        filter: (req, tgt, _rank, mutual) =>
            mutual &&
            ((req.role === "sponsor" && tgt.role === "delegate") ||
                (req.role === "delegate" && tgt.role === "sponsor")),
    },
    {
        // Pass 2: High-interest sponsor requests (rank >= 4), regardless of mutuality.
        // The sponsor cap is 50% of the company's maximum.
        passNumber: 2,
        day: 1,
        kind: "sponsor_delegate",
        diamondSpilloverDay: 2,
        delegateCap: 3,
        sponsorCap: (max) => sponsorPassCap(max, SPONSOR_PASS_SHARES[2]),
        filter: (req, tgt, rank, _mutual) =>
            req.role === "sponsor" && tgt.role === "delegate" && rank >= 4,
    },
    {
        // Pass 3: High-interest delegate requests for sponsors (rank >= 4), regardless of mutuality.
        // The sponsor cap is 75% of the company's maximum.
        passNumber: 3,
        day: 1,
        kind: "sponsor_delegate",
        diamondSpilloverDay: 2,
        delegateCap: 4,
        sponsorCap: (max) => sponsorPassCap(max, SPONSOR_PASS_SHARES[3]),
        filter: (req, tgt, rank, _mutual) =>
            req.role === "delegate" && tgt.role === "sponsor" && rank >= 4,
    },
    {
        // Pass 4: Second pass on mutual sponsor <-> delegate requests. Raises caps to fill remaining slots.
        // The sponsor cap rises to the company's full maximum.
        passNumber: 4,
        day: 1,
        kind: "sponsor_delegate",
        diamondSpilloverDay: 2,
        delegateCap: 5,
        sponsorCap: (max) => sponsorPassCap(max, SPONSOR_PASS_SHARES[4]),
        filter: (req, tgt, _rank, mutual) =>
            mutual &&
            ((req.role === "sponsor" && tgt.role === "delegate") ||
                (req.role === "delegate" && tgt.role === "sponsor")),
    },
    {
        // Pass 5: All remaining sponsor requests, any rank.
        // The final sponsor cap is the company's maximum from Salesforce (see companyMaximumMeetings).
        passNumber: 5,
        day: 1,
        kind: "sponsor_delegate",
        diamondSpilloverDay: 2,
        delegateCap: 7,
        sponsorCap: (max) => sponsorPassCap(max, SPONSOR_PASS_SHARES[5]),
        filter: (req, tgt, _rank, _mutual) =>
            req.role === "sponsor" && tgt.role === "delegate",
    },
    {
        // Pass 6: Mutual delegate <-> delegate requests on Day 2 only.
        passNumber: 6,
        day: 2,
        kind: "delegate_delegate",
        delegateCap: 2,
        sponsorCap: () => 0,
        filter: (req, tgt, _rank, mutual) =>
            mutual && req.role === "delegate" && tgt.role === "delegate",
    },
    {
        // Pass 7: All remaining delegate <-> delegate requests on Day 2, any rank.
        passNumber: 7,
        day: 2,
        kind: "delegate_delegate",
        delegateCap: 2,
        sponsorCap: () => 0,
        filter: (req, tgt, _rank, _mutual) =>
            req.role === "delegate" && tgt.role === "delegate",
    },
];

/**
 * Returns the cumulative meeting cap for a party under a given pass. For a
 * sponsor company the cap is a share of the company's maximum, so it is a single
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
        ? pass.sponsorCap(entity.maximum)
        : pass.delegateCap;
}

// The meeting kind each pass books, keyed by pass number.
// A meeting's kind is the kind of the pass that booked it.
const PASS_KIND = new Map(PASSES.map((p) => [p.passNumber, p.kind]));

/**
 * Counts the meetings that count toward an attendee's cap in a given pass.
 * Only meetings of the pass's kind are counted.
 *
 * Sponsor meetings count across every day.
 * A diamond sponsor can have Day 2 sponsor meetings, and they must still fit the package.
 * The same goes for a delegate's sponsor-meeting cap.
 *
 * Delegate-to-delegate meetings still count on the pass's day only, so their day rule is unchanged.
 *
 * @param {ScheduledMeeting[]} meetings - All meetings scheduled so far.
 * @param {string} attendeeId - The attendee to count for.
 * @param {PassConfig} pass - The current pass. Its kind and day decide what counts.
 * @returns {number} The number of this attendee's meetings that count toward the pass cap.
 */
function countMeetingsForCap(
    meetings: ScheduledMeeting[],
    attendeeId: string,
    pass: PassConfig,
): number {
    return meetings.filter(
        (m) =>
            (m.attendeeA === attendeeId || m.attendeeB === attendeeId) &&
            PASS_KIND.get(m.passNumber) === pass.kind &&
            (pass.kind === "sponsor_delegate" || m.day === pass.day),
    ).length;
}

/**
 * Returns the tier of the sponsor company in a pair, or null when neither side is a sponsor.
 *
 * @param {SchedEntity} a - One side of the pair.
 * @param {SchedEntity} b - The other side of the pair.
 * @returns {SponsorTier} The sponsor side's tier, or null.
 */
function sponsorTierOfPair(a: SchedEntity, b: SchedEntity): SponsorTier {
    if (a.role === "sponsor") return a.tier;
    if (b.role === "sponsor") return b.tier;
    return null;
}

/**
 * Meetings that already exist in Cvent, used to make the engine schedule around
 * them rather than generate conflicts.
 */
export interface PreexistingSchedule {
	/** Canonical pair keys (see pairKey) that already meet in Cvent, keyed by party id. */
	pairs?: Set<string>;
	/** Per-party (party id) ISO start times already booked in Cvent. For a
	 *  sponsor company this is the union of all its reps' booked times.
	 *  A map gives how many appointments the party already has at each start time,
	 *  so they count toward a company's meetings at once (see preexistingFromAppointments).
	 *  A set counts each listed start time once. */
	busyStartTimesByAttendee?: Map<string, BusyTimes>;
	/** How many appointments each party (party id) already has in Cvent, pushed portal meetings included.
	 *  A sponsor company's count starts from this, so existing meetings count toward its maximum. */
	meetingCountByParty?: Map<string, number>;
	/** Per party, the contact ids already hosting a Cvent appointment at each ISO start time.
	 *  A company's second or later meeting at a time is only booked when a rep who can host is free then. */
	busyHostsByParty?: Map<string, Map<string, Set<string>>>;
	/** How many Cvent appointments are at each location and start time, keyed by slotRoomKey.
	 *  A slot's room is its Cvent capacity minus these, since availableAppointments is the static setting. */
	bookedBySlot?: Map<string, number>;
	/** How many pushed portal meetings are in each timeslot, keyed by timeslot id.
	 *  Only used when `bookedBySlot` is missing, because Cvent's appointment list couldn't be read. */
	bookedByTimeslotId?: Map<string, number>;
}

/**
 * Normalizes a start time for matching against Cvent appointments.
 * A real date becomes its ISO string with milliseconds. Anything else is kept as is.
 *
 * @param {string} startTime - The start time.
 * @returns {string} The matching key.
 */
function startKey(startTime: string): string {
	const ms = Date.parse(startTime);
	return Number.isNaN(ms) ? startTime : new Date(ms).toISOString();
}

/**
 * Copies a party's pre-existing busy times into a count per start time.
 *
 * @param {BusyTimes | undefined} busy - The party's busy times, as a set or a count map.
 * @returns {Map<string, number>} A new count per start time.
 */
function toBusyCounts(busy: BusyTimes | undefined): Map<string, number> {
	const counts = new Map<string, number>();
	if (!busy) return counts;
	if (busy instanceof Map) {
		for (const [time, n] of busy as ReadonlyMap<string, number>) counts.set(time, n);
		return counts;
	}
	for (const time of busy as ReadonlySet<string>) counts.set(time, 1);
	return counts;
}

/**
 * Adds one meeting to a party's count at a start time.
 *
 * @param {Map<string, number>} busy - The party's count per start time.
 * @param {string} startTime - The booked start time.
 */
function addBusy(busy: Map<string, number>, startTime: string): void {
	busy.set(startTime, (busy.get(startTime) ?? 0) + 1);
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
 * A sponsor company's caps are shares of its meeting maximum from Salesforce (see
 * companyMaximumMeetings and SPONSOR_PASS_SHARES). A company may hold up to its
 * meetings-at-once limit at one start time (see companyMeetingsAtOnce), and a
 * delegate holds one at a time. Cvent's own per-slot capacity still applies on top.
 *
 * When the caller passes `booths`, each sponsor company only books slots at its
 * booth's location. A company with a booth problem, or missing from `booths`,
 * gets no meetings, and its pairs are skipped with that problem as the reason.
 * Without `booths` no booth rule applies. A company whose maximum is 0 gets no
 * meetings either way.
 *
 * Each pass only books timeslots mapped to its meeting kind in Event settings.
 * Sponsor passes (1 to 5) use `sponsor_delegate` slots on Day 1.
 * A diamond sponsor's pair may use a Day 2 `sponsor_delegate` slot when no Day 1 slot works.
 * Sponsor-meeting caps count across both days, so a diamond sponsor still stays within the package.
 * Passes 6 and 7 use `delegate_delegate` slots on Day 2.
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
 * @todo Update this note once delegates can request sponsors in the portal.
 * Those requests will arrive in `requests` like any sponsor's.
 * withDelegatePreferences() already skips an intake-form pick when the same portal request exists, so the portal rank wins.
 *
 * @param {Attendee[]} attendees - All attendees to schedule meetings for.
 * @param {MeetingRequest[]} requests - Meeting requests submitted through the portal.
 * @param {Timeslot[]} timeslots - The event's global, Cvent-sourced timeslots.
 * @param {Location[]} locations - The event's locations, for matching Cvent appointments to slots by location name.
 * @param {PreexistingSchedule} [preexisting] - Pairs/times already booked in Cvent to schedule around.
 * @param {Map<string, CompanyBooth>} [booths] - Each sponsor company's booth, keyed by Account id (see resolveCompanyBooths).
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
	locations: Location[],
	preexisting: PreexistingSchedule = {},
	booths?: Map<string, CompanyBooth>,
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
		const maximum = companyMaximumMeetings(c).maximum;

		// The booth rule applies only when the caller passed booths.
		// A company missing from them has no known booth, so it is treated as having none.
		const booth = booths ? booths.get(c.accountId) : undefined;
		const boothProblem = booths
			? (booth ? primaryBoothProblem(booth) : 'no_booth')
			: null;
		const blockedReason: SchedulerFailureReason | null =
			boothProblem ?? (maximum <= 0 ? 'no_package_meetings' : null);

		entityByParty.set(c.accountId, {
			partyId: c.accountId,
			role: "sponsor",
			tier: c.tier,
			companyKey: c.accountId,
			maxSameCompanyMeetings: null,
			name: c.name,
			company: c.name,
			maximum,
			atOnce: companyMeetingsAtOnce(c),
			hostContactIds: hostingReps(c).map(r => r.cventContactId),
			existingMeetings: preexisting.meetingCountByParty?.get(c.accountId) ?? 0,
			boothLocationId: booth?.location?.id,
			blockedReason,
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
			maximum: 0,
			// A delegate never has two meetings at the same start time.
			atOnce: 1,
			hostContactIds: [],
			existingMeetings: 0,
			blockedReason: null,
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

	// Per-party count of meetings at each start time already booked, so no party
	// holds more meetings at one wall-clock time than it may. Keyed by party id and
	// seeded from Cvent. A company's counts cover all its reps' appointments, as
	// built by buildPreexistingFromCvent. A delegate may hold 1 at a time, and a
	// sponsor company up to its meetings-at-once limit.
	const busyByAttendee = new Map<string, Map<string, number>>(
		[...entityByParty.keys()].map(pid => [
			pid,
			toBusyCounts(preexisting.busyStartTimesByAttendee?.get(pid)),
		])
	);

	// Remaining capacity per timeslot id, drawn down as meetings are booked.
	// Cvent's capacity is the location's static setting, so appointments already at that
	// location and time are taken off first. Appointments carry only a location name.
	const locationNameById = new Map(locations.map(l => [l.id, l.name]));
	const timeslotRemaining = new Map(timeslots.map(t => {
		// Without Cvent's appointment list, the pushed meetings in each timeslot are taken off instead.
		if (!preexisting.bookedBySlot) {
			return [t.id, t.capacity - (preexisting.bookedByTimeslotId?.get(t.id) ?? 0)];
		}
		const name = t.locationId ? locationNameById.get(t.locationId) : undefined;
		const booked = name ? (preexisting.bookedBySlot.get(slotRoomKey(name, t.startTime)) ?? 0) : 0;
		return [t.id, t.capacity - booked];
	}));

	// How many meetings this run has booked per party at each start time.
	// A company's next meeting then needs a rep who is free, counting these and its Cvent hosts.
	const newByParty = new Map<string, Map<string, number>>();

	/**
	 * Whether a sponsor company has a rep free to host one more meeting at a start time.
	 * The first meeting at a time is always allowed, even with no rep who can host.
	 * A later one needs a rep who can host, isn't hosting a Cvent appointment then, and isn't taken by this run.
	 *
	 * @param {SchedEntity} e - The party.
	 * @param {string} startTime - The start time.
	 * @returns {boolean} True when the party may book another meeting then.
	 */
	const hasFreeHost = (e: SchedEntity, startTime: string): boolean => {
		if (e.role !== 'sponsor') return true;
		const total = busyByAttendee.get(e.partyId)?.get(startTime) ?? 0;
		if (total === 0) return true;
		const busyHosts = preexisting.busyHostsByParty?.get(e.partyId)?.get(startKey(startTime));
		const free = e.hostContactIds.filter(id => !busyHosts?.has(id)).length;
		const booked = newByParty.get(e.partyId)?.get(startTime) ?? 0;
		return booked < free;
	};

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

			// Count each party's meetings that count toward this pass's cap.
			// Sponsor meetings count across both days (see countMeetingsForCap).
			/**
			 * A sponsor company's appointments already in Cvent, which count toward its sponsor-meeting caps too.
			 *
			 * @param {SchedEntity} e - The party.
			 * @returns {number} The count to add for this pass.
			 */
			const existingFor = (e: SchedEntity): number => (pass.kind === 'sponsor_delegate' ? e.existingMeetings : 0);
			const requesterCapCount = countMeetingsForCap(allMeetings, requesterParty, pass) + existingFor(requester);
			const targetCapCount    = countMeetingsForCap(allMeetings, targetParty,    pass) + existingFor(target);

			// Busy-time counts for each party, used to find a free timeslot below.
			const requesterBusy = busyByAttendee.get(requesterParty) ?? new Map<string, number>();
			const targetBusy    = busyByAttendee.get(targetParty)    ?? new Map<string, number>();

			// Skip if a sponsor company can't have meetings at all, because of its booth or package.
			// This comes before the cap check, so the report names the real reason.
			const blockedReason = requester.blockedReason ?? target.blockedReason;
			if (blockedReason) { skipReasons.set(key, blockedReason); continue; }

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
			if (requesterCapCount >= getCap(requester, pass)) { skipReasons.set(key, "cap_reached"); continue; }
			if (targetCapCount    >= getCap(target,    pass)) { skipReasons.set(key, "cap_reached"); continue; }

			// Skip if this meeting would violate the company diversity rule for either party.
			const requesterMaxSame = requester.maxSameCompanyMeetings ?? 2;
			const targetMaxSame    = target.maxSameCompanyMeetings    ?? 2;
			if (wouldViolateCompanyDiversity(allMeetings, entityByParty, requesterParty, targetParty, requesterMaxSame)) { skipReasons.set(key, "company_diversity"); continue; }
			if (wouldViolateCompanyDiversity(allMeetings, entityByParty, targetParty, requesterParty, targetMaxSame))    { skipReasons.set(key, "company_diversity"); continue; }

			// A sponsor company only meets at its booth, and may hold up to its at-once limit at one start time.
			const limits: SlotLimits = {
				locationId: requester.boothLocationId ?? target.boothLocationId,
				limitA: requester.atOnce,
				limitB: target.atOnce,
				canBookA: (startTime) => hasFreeHost(requester, startTime),
				canBookB: (startTime) => hasFreeHost(target, startTime),
			};

			// Find a timeslot of this pass's kind on this pass's day, where both attendees are free and capacity remains.
			let timeslot = findAvailableTimeslot(timeslots, pass.day, requesterBusy, targetBusy, timeslotRemaining, pass.kind, limits);

			// A diamond sponsor may use a slot on the spillover day, but only when no slot on the pass's day works for the pair.
			// Standard sponsors never spill over.
			if (
				!timeslot &&
				pass.diamondSpilloverDay &&
				sponsorTierOfPair(requester, target) === 'diamond'
			) {
				timeslot = findAvailableTimeslot(timeslots, pass.diamondSpilloverDay, requesterBusy, targetBusy, timeslotRemaining, pass.kind, limits);
			}

			// Skip this pair if no usable timeslot exists — the event is out of
			// appointment capacity for this day, or one of the two is already
			// booked at every remaining start time.
			if (!timeslot) { skipReasons.set(key, "no_availability"); continue; }

			// Book the timeslot: count one more meeting for both attendees at its start time and draw down capacity.
			addBusy(requesterBusy, timeslot.startTime);
			addBusy(targetBusy, timeslot.startTime);
			busyByAttendee.set(requesterParty, requesterBusy);
			busyByAttendee.set(targetParty, targetBusy);
			for (const party of [requesterParty, targetParty]) {
				const byTime = newByParty.get(party) ?? new Map<string, number>();
				byTime.set(timeslot.startTime, (byTime.get(timeslot.startTime) ?? 0) + 1);
				newByParty.set(party, byTime);
			}
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
				// The booked slot's day, which is Day 2 for a diamond sponsor's spillover.
				day: timeslot.day,
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
