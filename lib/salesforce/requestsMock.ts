import type { Attendee, MeetingRequest } from "@/types";

// ---------------------------------------------------------------------------
// Mock request generator
//
// Produces a synthetic requests.json compatible with the scheduling engine,
// driven by a real attendees list. Used only when generating placeholder data
// (the route gates this behind ?placeholders=true).
//
// Volume / shape mirrors data/mock/requests.json: 5–7 requests per attendee,
// ranks 3–5.
// ---------------------------------------------------------------------------

const MIN_REQUESTS_PER_ATTENDEE = 5;
const MAX_REQUESTS_PER_ATTENDEE = 7;
const POSSIBLE_RANKS = [3, 4, 5] as const;

/**
 * Returns a uniformly distributed integer in the inclusive range [min, max].
 *
 * @param {number} min - Lower bound (inclusive).
 * @param {number} max - Upper bound (inclusive).
 * @returns {number} A random integer in [min, max].
 */
function randInt(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Picks a random rank from POSSIBLE_RANKS.
 *
 * @returns {number} One of the allowed rank values (3, 4, or 5).
 */
function pickRank(): number {
    return POSSIBLE_RANKS[randInt(0, POSSIBLE_RANKS.length - 1)];
}

/**
 * Returns a new array containing the same elements as `arr` in random order.
 * Uses the in-place Fisher–Yates shuffle on a copy.
 *
 * @param {readonly T[]} arr - Source array (not mutated).
 * @returns {T[]} A new array with the elements reordered.
 */
function shuffle<T>(arr: readonly T[]): T[] {
    // Copy first so we never mutate the caller's array.
    const out = arr.slice();

    // Fisher–Yates: swap each position with a random earlier-or-equal index.
    for (let i = out.length - 1; i > 0; i--) {
        const j = randInt(0, i);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * Returns the subset of attendees that `requester` is allowed to request.
 * Role rules (from the engine's JSDoc):
 *   - Delegates can request sponsors (day 1) and other delegates (day 2).
 *   - Sponsors can request delegates (day 1) only.
 *   - Never self.
 *
 * @param {Attendee} requester - The attendee whose requests are being generated.
 * @param {readonly Attendee[]} all - The full attendee list to filter.
 * @returns {Attendee[]} Attendees eligible to be requested by `requester`.
 */
function eligibleTargets(
    requester: Attendee,
    all: readonly Attendee[],
): Attendee[] {
    return all.filter((a) => {
        // Self-requests are never valid.
        if (a.id === requester.id) return false;

        // Sponsors are only allowed to request delegates.
        if (requester.role === "sponsor") return a.role === "delegate";

        // Delegates may request anyone (sponsor or other delegate).
        return true;
    });
}

/**
 * Builds a randomized batch of requests for a single requester. Picks
 * 5–7 distinct targets from `candidates`, assigns a random rank to each, and
 * names the ids `req-NNN` continuing from `startingIndex`.
 *
 * @param {Attendee} requester - The attendee submitting the requests.
 * @param {readonly Attendee[]} candidates - Eligible target attendees.
 * @param {number} startingIndex - Numeric offset for sequential `req-NNN` ids.
 * @returns {MeetingRequest[]} The newly generated requests.
 */
export function generateRequestsForAttendee(
    requester: Attendee,
    candidates: readonly Attendee[],
    startingIndex: number,
): MeetingRequest[] {
    // Decide how many requests this attendee will make.
    const wanted = randInt(
        MIN_REQUESTS_PER_ATTENDEE,
        MAX_REQUESTS_PER_ATTENDEE,
    );

    // Shuffle and slice so we get distinct targets without replacement. If the
    // candidate pool is smaller than `wanted`, fall back to as many as we have.
    const targets = shuffle(candidates).slice(
        0,
        Math.min(wanted, candidates.length),
    );

    // Build one MeetingRequest per picked target.
    return targets.map((target, i) => ({
        id: `req-${String(startingIndex + i + 1).padStart(3, "0")}`,
        requesterId: requester.id,
        targetId: target.id,
        rank: pickRank(),
    }));
}

/**
 * Top-level mock generator: walks the attendees list once, producing a flat
 * `MeetingRequest[]` with `req-001`, `req-002`, … ids.
 *
 * @param {readonly Attendee[]} attendees - The attendees to generate requests from/about.
 * @returns {MeetingRequest[]} The combined list of generated requests.
 */
export function generateMockRequests(
    attendees: readonly Attendee[],
): MeetingRequest[] {
    // Accumulator for all generated requests; passed-through length is the
    // running id counter for `req-NNN` numbering.
    const requests: MeetingRequest[] = [];

    // For each attendee, compute their eligible pool then generate a batch.
    for (const requester of attendees) {
        const candidates = eligibleTargets(requester, attendees);

        // Skip attendees who have nobody valid to request (e.g. a lone sponsor
        // with no delegates in the list).
        if (candidates.length === 0) continue;

        const next = generateRequestsForAttendee(
            requester,
            candidates,
            requests.length,
        );
        requests.push(...next);
    }
    return requests;
}
