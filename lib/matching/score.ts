import type { AttendeeProfile } from "@/types";
import {
    QUESTION_BY_ID,
    informative,
    type AnswerScales,
    type MatchQuestion,
    type QuestionId,
} from "./questions";
import { questionWeights, type QuestionSetting } from "./settings";

// ---------------------------------------------------------------------------
// Match scoring for delegate matching.
//
// Scores two delegates, or a delegate against a group, using an event's question priorities.
// Every score comes with the shared answers that gave it points, so each match can be explained.
// Pure, so it can be tested without the database or Cvent.
// ---------------------------------------------------------------------------

/** One question two delegates have in common, and how much it counted. */
export type SharedAnswer = {
    questionId: QuestionId;
    /** The question's short name, for example "company size". */
    shortLabel: string;
    /** The answers both gave. For close but different bands, both bands. */
    values: string[];
    /** True when the answers are the same. False when two bands are only close. */
    exact: boolean;
    /** The weighted points this question gave, before the score is scaled to 100. */
    points: number;
};

/** A match score out of 100, with the shared answers that explain it. */
export type MatchScore = {
    /** 0 to 100. Higher is a better match. */
    score: number;
    /** The answers that gave points, highest-priority question first. Answers that gave none are left out. */
    shared: SharedAnswer[];
};

/** How alike two answers to one question are, from 0 to 1, and the answers behind it. */
type Similarity = { similarity: number; values: string[]; exact: boolean };

/**
 * How close two bands are on the event's ordered list.
 * The same band is 1, neighbouring bands are 0.5, and anything further apart is 0.
 * A band missing from the list only matches itself.
 *
 * @param {string} a - One band.
 * @param {string} b - The other band.
 * @param {string[]} order - The bands in order, smallest first.
 * @returns {number} The closeness.
 */
export function bandCloseness(a: string, b: string, order: string[]): number {
    if (a === b) return 1;
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia < 0 || ib < 0) return 0;
    return Math.abs(ia - ib) === 1 ? 0.5 : 0;
}

/**
 * Compares two delegates' answers to one question.
 * Returns null when either delegate didn't answer it.
 *
 * @param {MatchQuestion} q - The question.
 * @param {AttendeeProfile} a - One delegate's profile.
 * @param {AttendeeProfile} b - The other delegate's profile.
 * @param {AnswerScales} scales - The event's band orders.
 * @returns {Similarity | null} How alike the answers are, or null.
 */
export function compareAnswers(
    q: MatchQuestion,
    a: AttendeeProfile,
    b: AttendeeProfile,
    scales: AnswerScales,
): Similarity | null {
    if (q.compare === "closeness") {
        const parts: { closeness: number; a: string; b: string }[] = [];
        for (const band of q.bands ?? []) {
            const [va] = informative([band.read(a) ?? ""]);
            const [vb] = informative([band.read(b) ?? ""]);
            if (!va || !vb) continue;
            parts.push({ closeness: bandCloseness(va, vb, scales.get(band.scale) ?? []), a: va, b: vb });
        }
        if (parts.length === 0) return null;
        const similarity = parts.reduce((sum, p) => sum + p.closeness, 0) / parts.length;
        const exact = parts.every((p) => p.a === p.b);
        const values = exact ? parts.map((p) => p.a) : parts.flatMap((p) => (p.a === p.b ? [p.a] : [p.a, p.b]));
        return { similarity, values, exact };
    }

    const listA = informative(q.readChoices?.(a) ?? []);
    const listB = informative(q.readChoices?.(b) ?? []);
    if (listA.length === 0 || listB.length === 0) return null;
    const lowerB = new Set(listB.map((v) => v.toLowerCase()));
    const shared = listA.filter((v) => lowerB.has(v.toLowerCase()));
    const similarity = shared.length / Math.min(listA.length, listB.length);
    return { similarity, values: shared, exact: true };
}

/**
 * Scores two delegates using an event's question priorities.
 * Each enabled question gives its weight times how alike the answers are.
 * The total is scaled so a pair alike on every enabled question scores 100.
 * Turned-off questions never count.
 *
 * @param {AttendeeProfile} a - One delegate's profile.
 * @param {AttendeeProfile} b - The other delegate's profile.
 * @param {QuestionSetting[]} questions - The event's priority list.
 * @param {AnswerScales} scales - The event's band orders.
 * @returns {MatchScore} The score and the shared answers that explain it.
 */
export function scorePair(
    a: AttendeeProfile,
    b: AttendeeProfile,
    questions: QuestionSetting[],
    scales: AnswerScales,
): MatchScore {
    const weights = questionWeights(questions);
    let total = 0;
    let points = 0;
    const shared: SharedAnswer[] = [];
    for (const setting of questions) {
        const weight = weights.get(setting.id);
        const q = QUESTION_BY_ID.get(setting.id);
        if (!weight || !q) continue;
        total += weight;
        const sim = compareAnswers(q, a, b, scales);
        if (!sim || sim.similarity <= 0) continue;
        const p = weight * sim.similarity;
        points += p;
        shared.push({ questionId: q.id, shortLabel: q.shortLabel, values: sim.values, exact: sim.exact, points: p });
    }
    return { score: total > 0 ? Math.round((100 * points) / total) : 0, shared };
}

/**
 * Scores a delegate against a group, as the average of their scores with each member.
 * The shared answers are those they have in common with at least one member.
 * An empty group scores 0.
 *
 * @param {AttendeeProfile} candidate - The delegate being placed.
 * @param {AttendeeProfile[]} members - The group's members.
 * @param {QuestionSetting[]} questions - The event's priority list.
 * @param {AnswerScales} scales - The event's band orders.
 * @returns {MatchScore} The average score and the merged shared answers.
 */
export function scoreAgainstGroup(
    candidate: AttendeeProfile,
    members: AttendeeProfile[],
    questions: QuestionSetting[],
    scales: AnswerScales,
): MatchScore {
    if (members.length === 0) return { score: 0, shared: [] };
    const pairs = members.map((m) => scorePair(candidate, m, questions, scales));
    const byQuestion = new Map<QuestionId, SharedAnswer>();
    for (const pair of pairs) {
        for (const s of pair.shared) {
            const merged = byQuestion.get(s.questionId);
            if (!merged) {
                byQuestion.set(s.questionId, { ...s, values: [...s.values], points: s.points / pairs.length });
                continue;
            }
            for (const v of s.values) if (!merged.values.includes(v)) merged.values.push(v);
            merged.exact = merged.exact || s.exact;
            merged.points += s.points / pairs.length;
        }
    }
    const order = questions.map((q) => q.id);
    const shared = [...byQuestion.values()].sort((x, y) => order.indexOf(x.questionId) - order.indexOf(y.questionId));
    const score = Math.round(pairs.reduce((sum, p) => sum + p.score, 0) / pairs.length);
    return { score, shared };
}

/**
 * Explains a match in one line, for example "Both: Leadership Development, Workday. Same company size."
 * Choices both picked are listed by name.
 * Band questions say "Same" or "Similar" with the question's name, since a band alone reads oddly.
 *
 * @param {SharedAnswer[]} shared - The shared answers from a score.
 * @returns {string} The explanation, or "Nothing in common" when there are none.
 */
export function explainMatch(shared: SharedAnswer[]): string {
    const named: string[] = [];
    const same: string[] = [];
    const similar: string[] = [];
    for (const s of shared) {
        const q = QUESTION_BY_ID.get(s.questionId);
        if (q?.compare === "closeness") {
            (s.exact ? same : similar).push(s.shortLabel);
            continue;
        }
        for (const v of s.values) if (!named.includes(v)) named.push(v);
    }
    const parts: string[] = [];
    if (named.length) parts.push(`Both: ${named.join(", ")}.`);
    if (same.length) parts.push(`Same ${same.join(", ")}.`);
    if (similar.length) parts.push(`Similar ${similar.join(", ")}.`);
    return parts.length ? parts.join(" ") : "Nothing in common.";
}

/** One answer several members of a group share. */
export type GroupAnswer = {
    questionId: QuestionId;
    value: string;
    /** How many members gave it. Always 2 or more. */
    count: number;
};

/**
 * Lists the answers at least two members of a group share, for the table's summary.
 * Only enabled questions count.
 * Answers are sorted by question priority, then by how many members share them.
 *
 * @param {AttendeeProfile[]} members - The group's members.
 * @param {QuestionSetting[]} questions - The event's priority list.
 * @returns {GroupAnswer[]} The shared answers.
 */
export function groupSharedAnswers(
    members: AttendeeProfile[],
    questions: QuestionSetting[],
): GroupAnswer[] {
    const out: GroupAnswer[] = [];
    for (const setting of questions) {
        if (!setting.enabled) continue;
        const q = QUESTION_BY_ID.get(setting.id);
        if (!q) continue;
        const counts = new Map<string, number>();
        for (const m of members) {
            const values = q.bands
                ? informative(q.bands.map((b) => b.read(m) ?? ""))
                : informative(q.readChoices?.(m) ?? []);
            for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        const shared = [...counts.entries()]
            .filter(([, n]) => n >= 2)
            .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
            .map(([value, count]) => ({ questionId: q.id, value, count }));
        out.push(...shared);
    }
    return out;
}

/**
 * Explains what a group has in common in one line, for example "Leadership Development (4), Workday (3)".
 *
 * @param {GroupAnswer[]} answers - From groupSharedAnswers.
 * @param {number} [limit=6] - The most answers to list.
 * @returns {string} The summary, or "Nothing in common yet." when there are none.
 */
export function explainGroup(answers: GroupAnswer[], limit = 6): string {
    if (answers.length === 0) return "Nothing in common yet.";
    return answers
        .slice(0, limit)
        .map((a) => `${a.value} (${a.count})`)
        .join(", ");
}
