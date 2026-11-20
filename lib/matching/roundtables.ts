import type { Attendee, AttendeeProfile, Timeslot } from "@/types";
import { answeredCount, buildAnswerScales, type AnswerScales } from "./questions";
import {
    explainGroup,
    explainMatch,
    groupSharedAnswers,
    scoreAgainstGroup,
    type GroupAnswer,
} from "./score";
import type { QuestionSetting, RoundtableSettings } from "./settings";
import { sameCompany } from "./company";
import type { DelegateCounts } from "./delegateMeetings";
import { startMs } from "./d2d";

// ---------------------------------------------------------------------------
// The roundtable grouping engine.
//
// Roundtables are for delegates with no meetings at all.
// Each Cvent timeslot mapped to delegate_group, at its location, is one table.
// The engine groups eligible delegates into one group per table by shared answers.
// Admins then enter each table's theme, since the flow is group first, theme after.
// Each table also gets recommended alternates, and anyone left over is unassigned.
//
// Pure, so it can be tested without the database or Cvent.
// ---------------------------------------------------------------------------

/**
 * The description every new roundtable starts with.
 * Cvent needs a host on every appointment, so one seated delegate hosts each table.
 * This note tells delegates that the host has no duties, since roundtables are unmoderated.
 * Admins can edit it, add a discussion prompt to it, or clear it.
 * "Reset to default" on the roundtable page puts this text back.
 */
export const DEFAULT_ROUNDTABLE_DESCRIPTION =
    "The system requires one attendee to be designated as the meeting host in order to create the meeting. " +
    "However, this is purely a system requirement and does not involve any hosting or moderation responsibilities, " +
    "as all meetings are unmoderated.";

/**
 * The description "Reset to default" on the roundtable page puts back.
 *
 * @returns {string} The default host note.
 */
export function resetRoundtableDescription(): string {
    return DEFAULT_ROUNDTABLE_DESCRIPTION;
}

/**
 * The Salesforce id of a roundtable's Cvent host.
 * The host is the seated delegate with the lowest Salesforce id, so re-runs are stable.
 * Ids are compared the same way as the D2D host rule.
 *
 * @param {string[]} seatedIds - The Salesforce ids of the table's seated delegates.
 * @returns {string | null} The host's id, or null when no one is seated.
 */
export function roundtableHostId(seatedIds: string[]): string | null {
    let host: string | null = null;
    for (const id of seatedIds) {
        if (!id) continue;
        if (host === null || id < host) host = id;
    }
    return host;
}

/** Why a delegate can't be seated at a roundtable. */
export type RoundtableExclusion = "conference_only" | "has_meetings" | "cancelled";

/** One delegate placed at a table by the engine. */
export type SeatPick = {
    delegateId: string;
    /** Their score against the table's other seated delegates, 0 to 100. */
    score: number;
    /** What they share with the table, for example "Both: Leadership Development." */
    reason: string;
};

/** One table's group from the engine. */
export type RoundtableGroup = {
    timeslotId: string;
    locationId: string | null;
    day: number;
    startTime: string;
    /** The seated delegates, in seat order. */
    seated: SeatPick[];
    /** The recommended alternates, best first. They are never pushed to Cvent. */
    alternates: SeatPick[];
    /** The answers at least two seated delegates share, for the summary. */
    answers: GroupAnswer[];
    /** The shared answers in one line, for example "Leadership Development (4), Workday (3)". */
    summary: string;
    /** The seated delegates' average score with each other, 0 to 100. */
    averageScore: number;
    /** True when the average is below the event's minimum, so an admin should review it. */
    weak: boolean;
    /** True when fewer delegates qualified than the table seats. */
    short: boolean;
    /** The table's starting description, the default host note. */
    description: string;
};

/** Everything the roundtable engine needs. */
export type RoundtableInput = {
    /** The event's attendees. Only eligible delegates are grouped. */
    attendees: Attendee[];
    /** Each delegate's S2D and D2D meetings, in the portal and in Cvent. */
    counts: Map<string, DelegateCounts>;
    /** The event's timeslots. Each delegate_group slot is one table. */
    timeslots: Timeslot[];
    /** Timeslot ids of tables to leave alone, such as ones already pushed. */
    skipTimeslotIds?: Set<string>;
    /** Delegates already seated at tables left alone, so they aren't grouped again. */
    takenIds?: Set<string>;
    settings: RoundtableSettings;
    /** The event's band orders. Built from the eligible delegates when left out. */
    scales?: AnswerScales;
};

/** What a roundtable run produced. */
export type RoundtableResult = {
    groups: RoundtableGroup[];
    /** Eligible delegates neither seated nor an alternate, best fit first. */
    unassigned: string[];
    /** Every delegate who could be seated. */
    eligibleIds: string[];
    /** Delegates left out before grouping, and why. */
    excluded: { delegateId: string; reason: RoundtableExclusion }[];
};

/**
 * Why a delegate can't be seated at a roundtable, or null when they can.
 * Roundtables are for delegates with no S2D and no D2D meeting, in the portal or in Cvent.
 * Conference-only delegates never get a seat, and delegates who aren't registered in Cvent can't be pushed.
 *
 * @param {Attendee} a - The delegate.
 * @param {Map<string, DelegateCounts>} counts - Each delegate's meetings.
 * @returns {RoundtableExclusion | null} The reason, or null.
 */
export function roundtableExclusion(a: Attendee, counts: Map<string, DelegateCounts>): RoundtableExclusion | null {
    if (a.cventCancelled) return "cancelled";
    if (a.conferenceOnly) return "conference_only";
    const c = counts.get(a.salesforceId);
    if (c && c.s2d + c.d2d > 0) return "has_meetings";
    return null;
}

/**
 * The warning shown when roundtables run before any D2D meetings exist.
 * The run still goes ahead.
 *
 * @param {number} d2dMeetingCount - The event's D2D meetings, in the portal and in Cvent.
 * @returns {string | null} The warning, or null.
 */
export function roundtableOrderWarning(d2dMeetingCount: number): string | null {
    if (d2dMeetingCount > 0) return null;
    return (
        "No D2D meetings are scheduled yet. Scheduling runs S2D first, then D2D, then roundtables. " +
        "Delegates who later get a D2D meeting would need to come off their table."
    );
}

/**
 * The delegate_group slots that are tables, Day 1 first, then by start time and location.
 *
 * @param {Timeslot[]} timeslots - The event's timeslots.
 * @returns {Timeslot[]} The tables.
 */
export function roundtableSlots(timeslots: Timeslot[]): Timeslot[] {
    return timeslots
        .filter((t) => t.kind === "delegate_group")
        .sort(
            (x, y) =>
                x.day - y.day ||
                startMs(x.startTime) - startMs(y.startTime) ||
                (x.locationId ?? "").localeCompare(y.locationId ?? "") ||
                x.id.localeCompare(y.id),
        );
}

/**
 * Explains one seated delegate against the rest of their table.
 *
 * @param {AttendeeProfile} member - The delegate.
 * @param {AttendeeProfile[]} others - The table's other seated delegates.
 * @param {QuestionSetting[]} questions - The event's priority list.
 * @param {AnswerScales} scales - The event's band orders.
 * @returns {{ score: number; reason: string }} Their score and what they share.
 */
export function explainSeat(
    member: AttendeeProfile,
    others: AttendeeProfile[],
    questions: QuestionSetting[],
    scales: AnswerScales,
): { score: number; reason: string } {
    const s = scoreAgainstGroup(member, others, questions, scales);
    return { score: s.score, reason: others.length ? explainMatch(s.shared) : "First seat at the table." };
}

/**
 * Summarizes a table's seated delegates: shared answers, average score, and the weak and short flags.
 *
 * @param {Attendee[]} members - The seated delegates.
 * @param {RoundtableSettings} settings - The event's roundtable settings.
 * @param {AnswerScales} scales - The event's band orders.
 * @returns {{ seated: SeatPick[]; answers: GroupAnswer[]; summary: string; averageScore: number; weak: boolean; short: boolean }}
 */
export function summarizeTable(
    members: Attendee[],
    settings: RoundtableSettings,
    scales: AnswerScales,
): { seated: SeatPick[]; answers: GroupAnswer[]; summary: string; averageScore: number; weak: boolean; short: boolean } {
    const seated = members.map((m) => {
        const others = members.filter((o) => o !== m).map((o) => o.profile);
        return { delegateId: m.salesforceId, ...explainSeat(m.profile, others, settings.questions, scales) };
    });
    const answers = groupSharedAnswers(members.map((m) => m.profile), settings.questions);
    const averageScore =
        members.length >= 2 ? Math.round(seated.reduce((sum, s) => sum + s.score, 0) / seated.length) : 0;
    return {
        seated,
        answers,
        summary: explainGroup(answers),
        averageScore,
        weak: members.length >= 2 && averageScore < settings.minScore,
        short: members.length < settings.seatsPerTable,
    };
}

/**
 * Groups eligible delegates into one group per roundtable.
 *
 * 1. Each table gets a first delegate.
 *    The first table gets the most complete profile.
 *    Each next table gets, from the more complete profiles, the delegate least like the tables' first delegates, so tables differ.
 * 2. Tables then fill in rounds, so they stay even.
 *    Each round, the open tables with the fewest delegates take the best-fitting delegate left, by average score with the table.
 *    Ties go to the more complete profile, then by id so re-runs are stable.
 *    No table ever seats two people from the same company.
 * 3. Each table gets its alternates, the next-best fits, taken in turns across tables so no delegate is used twice.
 * 4. Everyone left is unassigned.
 *
 * A table that ends with fewer delegates than seats is marked short.
 * A table whose average score is below the minimum is marked weak.
 *
 * @param {RoundtableInput} input - The delegates, their meetings, the tables and the settings.
 * @returns {RoundtableResult} The groups, alternates and unassigned list.
 */
export function runRoundtableGrouping(input: RoundtableInput): RoundtableResult {
    const settings = input.settings;
    const taken = input.takenIds ?? new Set<string>();

    const eligible: Attendee[] = [];
    const excluded: RoundtableResult["excluded"] = [];
    for (const a of input.attendees) {
        if (a.role !== "delegate" || !a.salesforceId || taken.has(a.salesforceId)) continue;
        const reason = roundtableExclusion(a, input.counts);
        if (reason) excluded.push({ delegateId: a.salesforceId, reason });
        else eligible.push(a);
    }
    const completeness = new Map(eligible.map((a) => [a.salesforceId, answeredCount(a.profile)]));
    /**
     * Orders delegates by how complete their profile is, then by id.
     *
     * @param {Attendee} x - One delegate.
     * @param {Attendee} y - The other.
     * @returns {number} The sort order.
     */
    const byCompleteness = (x: Attendee, y: Attendee): number =>
        (completeness.get(y.salesforceId) ?? 0) - (completeness.get(x.salesforceId) ?? 0) ||
        x.salesforceId.localeCompare(y.salesforceId);
    eligible.sort(byCompleteness);
    const scales = input.scales ?? buildAnswerScales(eligible.map((a) => a.profile));
    const questions = settings.questions;

    const tables = roundtableSlots(input.timeslots).filter((t) => !input.skipTimeslotIds?.has(t.id));
    const members: Attendee[][] = tables.map(() => []);
    const remaining = new Set(eligible.map((a) => a.salesforceId));
    const byId = new Map(eligible.map((a) => [a.salesforceId, a]));
    /**
     * Whether a delegate may sit at a table under the same-company rule.
     *
     * @param {Attendee} a - The delegate.
     * @param {Attendee[]} group - The table's delegates.
     * @returns {boolean} True when no one at the table is from their company.
     */
    const fits = (a: Attendee, group: Attendee[]): boolean => !group.some((m) => sameCompany(m, a));

    // 1. First delegates, spread across the more complete profiles.
    if (settings.seatsPerTable > 0 && eligible.length > 0) {
        const poolSize = Math.min(eligible.length, Math.max(1, tables.length * 2));
        const floor = completeness.get(eligible[poolSize - 1].salesforceId) ?? 0;
        const pool = eligible.filter((a) => (completeness.get(a.salesforceId) ?? 0) >= floor);
        const seeds: Attendee[] = [];
        for (let t = 0; t < tables.length; t++) {
            let best: { a: Attendee; likeness: number } | null = null;
            for (const a of pool) {
                if (!remaining.has(a.salesforceId)) continue;
                const likeness = seeds.length
                    ? Math.max(...seeds.map((s) => scoreAgainstGroup(a.profile, [s.profile], questions, scales).score))
                    : 0;
                if (!best || likeness < best.likeness) best = { a, likeness };
            }
            if (!best) break;
            seeds.push(best.a);
            members[t].push(best.a);
            remaining.delete(best.a.salesforceId);
        }
    }

    // 2. Fill in rounds, smallest tables first.
    const closed = new Set<number>();
    for (;;) {
        const open = members
            .map((m, i) => ({ i, size: m.length }))
            .filter((t) => !closed.has(t.i) && t.size < settings.seatsPerTable);
        if (open.length === 0 || remaining.size === 0) break;
        const minSize = Math.min(...open.map((t) => t.size));
        const candidates = open.filter((t) => t.size === minSize);

        let best: { a: Attendee; table: number; score: number } | null = null;
        for (const { i } of candidates) {
            for (const id of remaining) {
                const a = byId.get(id)!;
                if (!fits(a, members[i])) continue;
                const score = members[i].length
                    ? scoreAgainstGroup(a.profile, members[i].map((m) => m.profile), questions, scales).score
                    : 0;
                // Tables are checked in order, so an exact tie stays with the earlier table.
                if (!best || score > best.score || (score === best.score && byCompleteness(a, best.a) < 0)) {
                    best = { a, table: i, score };
                }
            }
        }
        if (!best) {
            // No one left can sit at the smallest open tables, so they stay short.
            for (const { i } of candidates) closed.add(i);
            continue;
        }
        members[best.table].push(best.a);
        remaining.delete(best.a.salesforceId);
    }

    // 3. Alternates, in turns across tables.
    const alternates: Attendee[][] = tables.map(() => []);
    for (let round = 0; round < settings.alternatesPerTable; round++) {
        for (let t = 0; t < tables.length; t++) {
            if (members[t].length === 0) continue;
            let best: { a: Attendee; score: number } | null = null;
            for (const id of remaining) {
                const a = byId.get(id)!;
                if (!fits(a, members[t])) continue;
                const score = scoreAgainstGroup(a.profile, members[t].map((m) => m.profile), questions, scales).score;
                if (!best || score > best.score || (score === best.score && byCompleteness(a, best.a) < 0)) {
                    best = { a, score };
                }
            }
            if (!best) continue;
            alternates[t].push(best.a);
            remaining.delete(best.a.salesforceId);
        }
    }

    const groups: RoundtableGroup[] = tables.map((slot, t) => {
        const summary = summarizeTable(members[t], settings, scales);
        return {
            timeslotId: slot.id,
            locationId: slot.locationId,
            day: slot.day,
            startTime: slot.startTime,
            ...summary,
            description: DEFAULT_ROUNDTABLE_DESCRIPTION,
            alternates: alternates[t].map((a) => ({
                delegateId: a.salesforceId,
                ...explainSeat(a.profile, members[t].map((m) => m.profile), questions, scales),
            })),
        };
    });

    return {
        groups,
        unassigned: eligible.filter((a) => remaining.has(a.salesforceId)).map((a) => a.salesforceId),
        eligibleIds: eligible.map((a) => a.salesforceId),
        excluded,
    };
}

/** The result of checking a move onto a table. */
export type SeatCheck = {
    /** Problems that stop the move, such as two people from one company. */
    errors: string[];
    /** Things the admin should know before saving. */
    warnings: string[];
};

/**
 * Checks moving a delegate onto a table, as a seat or an alternate.
 *
 * A seat is refused when someone at the table is from their company, when they are busy at the table's time,
 * or when the table is full.
 * An alternate from a seated delegate's company is allowed with a warning, since alternates aren't seated.
 * A delegate who no longer qualifies, for example because they now have a meeting, gets a warning.
 *
 * @param {{ delegate: Attendee; role: "seated" | "alternate"; seated: Attendee[]; seats: number; tableStart: string; busy: Set<number>; exclusion: RoundtableExclusion | null }} params
 *   The delegate, the role, the table's other seated delegates, its seat count and start time, the delegate's busy times and why they don't qualify.
 * @returns {SeatCheck} The errors and warnings.
 */
export function checkSeatMove(params: {
    delegate: Attendee;
    role: "seated" | "alternate";
    seated: Attendee[];
    seats: number;
    tableStart: string;
    busy: Set<number>;
    exclusion: RoundtableExclusion | null;
}): SeatCheck {
    const errors: string[] = [];
    const warnings: string[] = [];
    const others = params.seated.filter((m) => m.salesforceId !== params.delegate.salesforceId);
    const colleague = others.find((m) => sameCompany(m, params.delegate));
    if (colleague) {
        const message = `${colleague.name} at this table is also from ${params.delegate.company || "their company"}.`;
        if (params.role === "seated") errors.push(`${params.delegate.name} can't sit here. ${message}`);
        else warnings.push(`${message} ${params.delegate.name} can't be swapped in while they are seated.`);
    }
    if (params.role === "seated") {
        if (params.busy.has(startMs(params.tableStart))) {
            errors.push(`${params.delegate.name} already has a meeting at this table's time.`);
        }
        if (others.length >= params.seats) {
            errors.push(`This table already seats ${params.seats}. Move someone off it first.`);
        }
    }
    if (params.exclusion === "has_meetings") {
        warnings.push(`${params.delegate.name} now has a meeting, so roundtables aren't meant for them.`);
    } else if (params.exclusion === "conference_only") {
        warnings.push(`${params.delegate.name} is conference-only, so they shouldn't get a seat.`);
    } else if (params.exclusion === "cancelled") {
        warnings.push(`${params.delegate.name} isn't registered in Cvent.`);
    }
    return { errors, warnings };
}
