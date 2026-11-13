import type { Attendee, ScheduledMeeting, Timeslot } from "@/types";
import { pairKey } from "@/lib/scheduling/helpers";
import { answeredCount, buildAnswerScales, type AnswerScales } from "./questions";
import { scorePair, type SharedAnswer } from "./score";
import type { D2DSettings } from "./settings";
import { sameCompany } from "./company";

// ---------------------------------------------------------------------------
// The D2D one-on-one engine.
//
// Pairs delegates who answered their Networking Profile alike into delegate_delegate slots.
// It scores every eligible pair, then books the best pairs first into the earliest slot both are free.
// It stops when caps or slots run out.
// It takes busy times from the caller, so S2D meetings and Cvent-only appointments are never double-booked.
//
// Pure, so it can be tested without the database or Cvent.
// ---------------------------------------------------------------------------

/**
 * The pass number stored on D2D meetings.
 * It is the number the old request-based D2D pass used, so a D2D meeting reads the same in reports.
 */
export const D2D_PASS_NUMBER = 6;

/** Why a delegate was left out of D2D matching before any pairing. */
export type D2DExclusion = "conference_only" | "incomplete_profile" | "cancelled";

/** Why an eligible delegate ended up with no D2D meeting. */
export type D2DUnmatchedReason =
    /** Every other eligible delegate is from the same company or shares no answers with them. */
    | "no_partner"
    /** They had acceptable partners, but no slot worked for both, or the partners were full. */
    | "no_slot";

/** A D2D meeting from the engine, with its score and explanation. */
export type D2DMatch = ScheduledMeeting & {
    /** The pair's match score, 0 to 100. */
    score: number;
    /** True when the score is below the event's minimum, so an admin should review it. */
    weak: boolean;
    /** The answers the two have in common. */
    shared: SharedAnswer[];
};

/** A D2D meeting kept from before the run, so it counts toward caps and the Day 1 rule. */
export type ExistingD2D = { attendeeA: string; attendeeB: string; day: number };

/** Everything the D2D engine needs. */
export type D2DInput = {
    /** The event's attendees. Only eligible delegates are matched. */
    attendees: Attendee[];
    /** Each delegate's S2D meetings, in the portal and in Cvent, by Salesforce id. */
    s2dCountById: Map<string, number>;
    /** D2D meetings that stay, such as pushed ones and delegate appointments made in Cvent. */
    existingD2D: ExistingD2D[];
    /** Start times (epoch ms) each delegate is already booked at, by Salesforce id. */
    busyById: Map<string, Set<number>>;
    /** The event's timeslots. Only delegate_delegate slots are used. */
    timeslots: Timeslot[];
    /** How many more meetings each timeslot can take, by timeslot id. A slot missing here uses its capacity. */
    slotRemaining?: Map<string, number>;
    settings: D2DSettings;
    /** The event's band orders. Built from the eligible delegates when left out. */
    scales?: AnswerScales;
    /** Used in meeting ids so they stay unique across runs. Defaults to now. */
    now?: number;
};

/** What a D2D run produced. */
export type D2DResult = {
    meetings: D2DMatch[];
    /** Eligible delegates with room for a meeting who got none, and why. */
    unmatched: { delegateId: string; reason: D2DUnmatchedReason }[];
    /** Delegates left out before pairing, and why. */
    excluded: { delegateId: string; reason: D2DExclusion }[];
    /** The Salesforce ids of every delegate who could be matched. */
    eligibleIds: string[];
};

/**
 * Why a delegate can't be matched for D2D, or null when they can.
 * Conference-only delegates and delegates without a completed profile are never matched.
 * Delegates who cancelled in Cvent aren't either, since Cvent won't take them.
 *
 * @param {Attendee} a - The attendee, already known to be a delegate.
 * @returns {D2DExclusion | null} The reason, or null.
 */
export function d2dExclusion(a: Attendee): D2DExclusion | null {
    if (a.cventCancelled) return "cancelled";
    if (a.conferenceOnly) return "conference_only";
    if (!a.networkingProfileComplete) return "incomplete_profile";
    return null;
}

/**
 * A delegate's total meeting cap, S2D and D2D together.
 * A delegate with no S2D meetings gets the lower cap, all D2D.
 *
 * @param {number} s2dCount - The delegate's S2D meetings.
 * @param {D2DSettings} settings - The event's D2D settings.
 * @returns {number} The cap.
 */
export function totalMeetingCap(s2dCount: number, settings: D2DSettings): number {
    return s2dCount > 0 ? settings.capWithS2D : settings.capWithoutS2D;
}

/**
 * The warning shown when D2D runs before any S2D meetings exist.
 * The run still goes ahead.
 *
 * @param {number} s2dMeetingCount - The event's S2D meetings, in the portal and in Cvent.
 * @returns {string | null} The warning, or null.
 */
export function d2dOrderWarning(s2dMeetingCount: number): string | null {
    if (s2dMeetingCount > 0) return null;
    return (
        "No sponsor meetings are scheduled yet. Scheduling runs S2D first, then D2D, then roundtables. " +
        "Every delegate is treated as having no sponsor meetings, so they get the lower meeting cap."
    );
}

/**
 * Turns an ISO time into epoch ms, the key busy times use.
 *
 * @param {string} iso - The ISO time.
 * @returns {number} Epoch ms.
 */
export function startMs(iso: string): number {
    return new Date(iso).getTime();
}

/**
 * Runs D2D matching.
 *
 * Every eligible pair from different companies is scored.
 * A pair that shares nothing is not acceptable and is never booked.
 * Pairs are booked best first, with ties going to the pair who answered more questions, then by id so re-runs are stable.
 * Each pair gets the earliest delegate_delegate slot, Day 1 first, where both are free and the slot has room.
 * A delegate's S2D and D2D meetings together never go over their cap.
 * A delegate with a D2D meeting and none on Day 1 can't get another on Day 2, so anyone with more than one has one on Day 1.
 * The host, attendeeA, is the delegate with the lower Salesforce id.
 * A pair below the event's minimum score is still booked but marked weak.
 *
 * @param {D2DInput} input - The delegates, busy times, slots and settings.
 * @returns {D2DResult} The new meetings, and who was left unmatched or excluded.
 */
export function runD2DMatching(input: D2DInput): D2DResult {
    const now = input.now ?? Date.now();
    const settings = input.settings;

    // Split delegates into those who can be matched and those left out.
    const eligible: Attendee[] = [];
    const excluded: D2DResult["excluded"] = [];
    for (const a of input.attendees) {
        if (a.role !== "delegate" || !a.salesforceId) continue;
        const reason = d2dExclusion(a);
        if (reason) excluded.push({ delegateId: a.salesforceId, reason });
        else eligible.push(a);
    }
    eligible.sort((x, y) => x.salesforceId.localeCompare(y.salesforceId));
    const scales = input.scales ?? buildAnswerScales(eligible.map((a) => a.profile));

    // Each delegate's D2D meetings so far, Day 1 meetings among them, and room left under the cap.
    const d2dCount = new Map<string, number>();
    const day1Count = new Map<string, number>();
    const existingPairs = new Set<string>();
    for (const m of input.existingD2D) {
        existingPairs.add(pairKey(m.attendeeA, m.attendeeB));
        for (const id of [m.attendeeA, m.attendeeB]) {
            d2dCount.set(id, (d2dCount.get(id) ?? 0) + 1);
            if (m.day === 1) day1Count.set(id, (day1Count.get(id) ?? 0) + 1);
        }
    }
    /**
     * How many more D2D meetings a delegate may have.
     *
     * @param {string} id - The delegate's Salesforce id.
     * @returns {number} The room left, 0 or more.
     */
    const roomLeft = (id: string): number => {
        const s2d = input.s2dCountById.get(id) ?? 0;
        return Math.max(0, totalMeetingCap(s2d, settings) - s2d - (d2dCount.get(id) ?? 0));
    };
    const hadRoom = new Set(eligible.filter((a) => roomLeft(a.salesforceId) > 0).map((a) => a.salesforceId));

    // Score every acceptable pair.
    type Pair = { a: Attendee; b: Attendee; score: number; shared: SharedAnswer[]; answered: number; key: string };
    const pairs: Pair[] = [];
    const hasPartner = new Set<string>();
    for (let i = 0; i < eligible.length; i++) {
        for (let j = i + 1; j < eligible.length; j++) {
            const a = eligible[i];
            const b = eligible[j];
            if (sameCompany(a, b)) continue;
            const key = pairKey(a.salesforceId, b.salesforceId);
            if (existingPairs.has(key)) continue;
            const { score, shared } = scorePair(a.profile, b.profile, settings.questions, scales);
            if (score <= 0) continue;
            hasPartner.add(a.salesforceId);
            hasPartner.add(b.salesforceId);
            pairs.push({ a, b, score, shared, key, answered: answeredCount(a.profile) + answeredCount(b.profile) });
        }
    }
    pairs.sort((x, y) => y.score - x.score || y.answered - x.answered || x.key.localeCompare(y.key));

    // D2D slots, Day 1 first, then by start time.
    const slots = input.timeslots
        .filter((t) => t.kind === "delegate_delegate" && (t.day === 1 || t.day === 2))
        .sort((x, y) => x.day - y.day || startMs(x.startTime) - startMs(y.startTime) || x.id.localeCompare(y.id));
    const remaining = new Map(slots.map((t) => [t.id, input.slotRemaining?.get(t.id) ?? t.capacity]));
    const busy = new Map<string, Set<number>>();
    for (const a of eligible) busy.set(a.salesforceId, new Set(input.busyById.get(a.salesforceId) ?? []));

    /**
     * Whether a delegate may take a meeting in a slot under the Day 1 rule.
     * A delegate with a D2D meeting but none on Day 1 can't get another on Day 2.
     *
     * @param {string} id - The delegate's Salesforce id.
     * @param {Timeslot} slot - The slot.
     * @returns {boolean} True when the day is allowed.
     */
    const dayAllowed = (id: string, slot: Timeslot): boolean =>
        slot.day === 1 || (d2dCount.get(id) ?? 0) === 0 || (day1Count.get(id) ?? 0) > 0;

    const meetings: D2DMatch[] = [];
    let counter = 1;
    for (const p of pairs) {
        const idA = p.a.salesforceId;
        const idB = p.b.salesforceId;
        if (roomLeft(idA) <= 0 || roomLeft(idB) <= 0) continue;
        const busyA = busy.get(idA)!;
        const busyB = busy.get(idB)!;
        const slot = slots.find((t) => {
            const ms = startMs(t.startTime);
            return (
                (remaining.get(t.id) ?? 0) > 0 &&
                !busyA.has(ms) &&
                !busyB.has(ms) &&
                dayAllowed(idA, t) &&
                dayAllowed(idB, t)
            );
        });
        if (!slot) continue;

        // Book it. The lower Salesforce id hosts, so re-runs are stable.
        const ms = startMs(slot.startTime);
        busyA.add(ms);
        busyB.add(ms);
        remaining.set(slot.id, (remaining.get(slot.id) ?? 0) - 1);
        for (const id of [idA, idB]) {
            d2dCount.set(id, (d2dCount.get(id) ?? 0) + 1);
            if (slot.day === 1) day1Count.set(id, (day1Count.get(id) ?? 0) + 1);
        }
        const [host, other] = idA < idB ? [idA, idB] : [idB, idA];
        meetings.push({
            // A timestamp suffix keeps ids unique across runs, since Cvent never frees an appointment code.
            id: `d2d-${String(counter++).padStart(3, "0")}-${now}`,
            attendeeA: host,
            attendeeB: other,
            day: slot.day,
            timeslotId: slot.id,
            passNumber: D2D_PASS_NUMBER,
            mutual: false,
            matchKind: "profile_match",
            rank: null,
            source: "portal",
            locationId: slot.locationId,
            cventAppointmentId: null,
            lastModifiedAt: null,
            lastPushedAt: null,
            score: p.score,
            weak: p.score < settings.minScore,
            shared: p.shared,
        });
    }

    // Eligible delegates who had room but got no D2D meeting at all.
    const unmatched: D2DResult["unmatched"] = eligible
        .filter((a) => hadRoom.has(a.salesforceId) && (d2dCount.get(a.salesforceId) ?? 0) === 0)
        .map((a) => ({
            delegateId: a.salesforceId,
            reason: hasPartner.has(a.salesforceId) ? "no_slot" : "no_partner",
        }));

    return { meetings, unmatched, excluded, eligibleIds: eligible.map((a) => a.salesforceId) };
}
