import type { Attendee, MeetingRequest } from "@/types";

// Mirrors data/mock/requests.json: 5–7 requests per attendee, ranks 3–5.
const MIN_REQUESTS_PER_ATTENDEE = 5;
const MAX_REQUESTS_PER_ATTENDEE = 7;
const POSSIBLE_RANKS = [3, 4, 5] as const;

function randInt(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function pickRank(): number {
    return POSSIBLE_RANKS[randInt(0, POSSIBLE_RANKS.length - 1)];
}

function shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = randInt(0, i);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * Valid request targets for a given requester:
 * - Delegates can request sponsors (day 1) and other delegates (day 2).
 * - Sponsors can request delegates (day 1) only.
 * Never self.
 */
function eligibleTargets(requester: Attendee, all: readonly Attendee[]): Attendee[] {
    return all.filter((a) => {
        if (a.id === requester.id) return false;
        if (requester.role === "sponsor") return a.role === "delegate";
        return true;
    });
}

export function generateRequestsForAttendee(
    requester: Attendee,
    candidates: readonly Attendee[],
    startingIndex: number,
): MeetingRequest[] {
    const wanted = randInt(MIN_REQUESTS_PER_ATTENDEE, MAX_REQUESTS_PER_ATTENDEE);
    const targets = shuffle(candidates).slice(0, Math.min(wanted, candidates.length));
    return targets.map((target, i) => ({
        id: `req-${String(startingIndex + i + 1).padStart(3, "0")}`,
        requesterId: requester.id,
        targetId: target.id,
        rank: pickRank(),
    }));
}

export function generateMockRequests(attendees: readonly Attendee[]): MeetingRequest[] {
    const requests: MeetingRequest[] = [];
    for (const requester of attendees) {
        const candidates = eligibleTargets(requester, attendees);
        if (candidates.length === 0) continue;
        const next = generateRequestsForAttendee(requester, candidates, requests.length);
        requests.push(...next);
    }
    return requests;
}
