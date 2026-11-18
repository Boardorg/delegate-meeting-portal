import { QUESTION_IDS, isQuestionId, type QuestionId } from "./questions";

// ---------------------------------------------------------------------------
// Per-event delegate matching settings.
//
// Stored as jsonb in event_settings.matching_settings and edited on the Matching Settings page.
// Null, or any missing or bad part, falls back to the defaults below.
// Pure, so the page, the server actions and both engines share it.
// ---------------------------------------------------------------------------

/** One question in a priority list. Higher in the list counts for more. */
export type QuestionSetting = { id: QuestionId; enabled: boolean };

/** The D2D one-on-one settings. */
export type D2DSettings = {
    /** Every matchable question, in priority order. */
    questions: QuestionSetting[];
    /** The most meetings in total, S2D and D2D, for a delegate with no S2D meetings. */
    capWithoutS2D: number;
    /** The most meetings in total, S2D and D2D, for a delegate with S2D meetings. */
    capWithS2D: number;
    /** A pair scoring below this, out of 100, is marked as a weak match. */
    minScore: number;
};

/** The roundtable settings. */
export type RoundtableSettings = {
    /** Every matchable question, in priority order. */
    questions: QuestionSetting[];
    /** How many delegates each table seats. */
    seatsPerTable: number;
    /** How many recommended alternates each table gets. */
    alternatesPerTable: number;
    /** A table whose average score is below this, out of 100, is marked as a weak match. */
    minScore: number;
};

/** An event's matching settings, with every part filled in. */
export type MatchingSettings = {
    d2d: D2DSettings;
    roundtables: RoundtableSettings;
};

/**
 * What event_settings.matching_settings holds.
 * It is the same shape as MatchingSettings, but read loosely, since older or hand-edited rows may miss parts.
 */
export type StoredMatchingSettings = {
    d2d?: Partial<D2DSettings>;
    roundtables?: Partial<RoundtableSettings>;
};

/**
 * The delegate team's ranking, which each event starts from.
 * Transformation stage and budget responsibility are available but off.
 */
export const DEFAULT_QUESTIONS: QuestionSetting[] = [
    { id: "one_to_one_interests", enabled: true },
    { id: "current_focus_topics", enabled: true },
    { id: "systems_and_platforms", enabled: true },
    { id: "company_size", enabled: true },
    { id: "initiative_priority", enabled: true },
    { id: "transformation_stage", enabled: false },
    { id: "budget_responsibility", enabled: false },
];

/**
 * The default minimum match score, out of 100.
 * The spec leaves the number to the event team, so this is a starting point to tune on Matching Settings.
 */
export const DEFAULT_MIN_SCORE = 20;

/** The settings an event uses when nothing is saved. */
export const DEFAULT_MATCHING_SETTINGS: MatchingSettings = {
    d2d: {
        questions: DEFAULT_QUESTIONS,
        capWithoutS2D: 4,
        capWithS2D: 5,
        minScore: DEFAULT_MIN_SCORE,
    },
    roundtables: {
        questions: DEFAULT_QUESTIONS,
        seatsPerTable: 5,
        alternatesPerTable: 2,
        minScore: DEFAULT_MIN_SCORE,
    },
};

/**
 * Reads a whole number within limits, or the fallback.
 *
 * @param {unknown} value - The stored value.
 * @param {number} fallback - The value to use when it is missing or out of range.
 * @param {number} min - The smallest allowed value.
 * @param {number} max - The largest allowed value.
 * @returns {number} The number.
 */
function wholeNumber(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
    if (value < min || value > max) return fallback;
    return value;
}

/**
 * Cleans a stored question list.
 * Unknown ids and repeats are dropped.
 * Questions the list leaves out are added at the end, turned off, so a new question never switches itself on.
 * A missing or empty list gives the defaults.
 *
 * @param {unknown} value - The stored list.
 * @returns {QuestionSetting[]} Every question, once, in priority order.
 */
export function resolveQuestions(value: unknown): QuestionSetting[] {
    if (!Array.isArray(value) || value.length === 0) return DEFAULT_QUESTIONS;
    const out: QuestionSetting[] = [];
    for (const item of value) {
        const id = (item as { id?: unknown })?.id;
        if (!isQuestionId(id) || out.some((q) => q.id === id)) continue;
        out.push({ id, enabled: (item as { enabled?: unknown }).enabled === true });
    }
    if (out.length === 0) return DEFAULT_QUESTIONS;
    for (const id of QUESTION_IDS) {
        if (!out.some((q) => q.id === id)) out.push({ id, enabled: false });
    }
    return out;
}

/**
 * Fills in an event's matching settings from what is stored.
 * Null, and any missing or bad part, falls back to the defaults.
 *
 * @param {unknown} stored - event_settings.matching_settings.
 * @returns {MatchingSettings} The settings to use.
 */
export function resolveMatchingSettings(stored: unknown): MatchingSettings {
    const s = (stored && typeof stored === "object" ? stored : {}) as StoredMatchingSettings;
    const d = (s.d2d && typeof s.d2d === "object" ? s.d2d : {}) as Partial<D2DSettings>;
    const r = (s.roundtables && typeof s.roundtables === "object" ? s.roundtables : {}) as Partial<RoundtableSettings>;
    const dd = DEFAULT_MATCHING_SETTINGS.d2d;
    const rd = DEFAULT_MATCHING_SETTINGS.roundtables;
    return {
        d2d: {
            questions: resolveQuestions(d.questions),
            capWithoutS2D: wholeNumber(d.capWithoutS2D, dd.capWithoutS2D, 0, 20),
            capWithS2D: wholeNumber(d.capWithS2D, dd.capWithS2D, 0, 20),
            minScore: wholeNumber(d.minScore, dd.minScore, 0, 100),
        },
        roundtables: {
            questions: resolveQuestions(r.questions),
            seatsPerTable: wholeNumber(r.seatsPerTable, rd.seatsPerTable, 1, 50),
            alternatesPerTable: wholeNumber(r.alternatesPerTable, rd.alternatesPerTable, 0, 10),
            minScore: wholeNumber(r.minScore, rd.minScore, 0, 100),
        },
    };
}

/**
 * Validates settings submitted from the Matching Settings page before they are saved.
 * Numbers must be whole and in range, and each list must hold every question once.
 *
 * @param {unknown} input - The submitted settings.
 * @returns {{ ok: true; settings: MatchingSettings } | { ok: false; error: string }} The clean settings, or a message.
 */
export function parseMatchingSettings(
    input: unknown,
): { ok: true; settings: MatchingSettings } | { ok: false; error: string } {
    if (!input || typeof input !== "object") {
        return { ok: false, error: "Error: matching settings are missing" };
    }
    const s = input as { d2d?: Record<string, unknown>; roundtables?: Record<string, unknown> };
    const checks: [unknown, string, number, number][] = [
        [s.d2d?.capWithoutS2D, "Meetings for a delegate with no sponsor meetings", 0, 20],
        [s.d2d?.capWithS2D, "Meetings for a delegate with sponsor meetings", 0, 20],
        [s.d2d?.minScore, "D2D minimum score", 0, 100],
        [s.roundtables?.seatsPerTable, "Seats per table", 1, 50],
        [s.roundtables?.alternatesPerTable, "Alternates per table", 0, 10],
        [s.roundtables?.minScore, "Roundtable minimum score", 0, 100],
    ];
    for (const [value, label, min, max] of checks) {
        if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
            return { ok: false, error: `Error: ${label} must be a whole number from ${min} to ${max}` };
        }
    }
    for (const list of [s.d2d?.questions, s.roundtables?.questions]) {
        if (!Array.isArray(list)) return { ok: false, error: "Error: a question list is missing" };
        const ids = list.map((q) => (q as { id?: unknown })?.id);
        if (ids.length !== QUESTION_IDS.length || !QUESTION_IDS.every((id) => ids.includes(id))) {
            return { ok: false, error: "Error: each question list must hold every question once" };
        }
    }
    return { ok: true, settings: resolveMatchingSettings(input) };
}

/**
 * Each enabled question's weight, from its place in the list.
 * With n enabled questions the first weighs n and the last weighs 1, so higher questions count for more.
 * Turned-off questions get no weight.
 *
 * @param {QuestionSetting[]} questions - The priority list.
 * @returns {Map<QuestionId, number>} The weight per enabled question.
 */
export function questionWeights(questions: QuestionSetting[]): Map<QuestionId, number> {
    const enabled = questions.filter((q) => q.enabled);
    return new Map(enabled.map((q, i) => [q.id, enabled.length - i]));
}
