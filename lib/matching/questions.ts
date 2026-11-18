import type { AttendeeProfile } from "@/types";
import { isNonAnswer } from "@/lib/attendees/formatProfile";
import { orderValues } from "@/app/components/catalogFormat";

// ---------------------------------------------------------------------------
// The Networking Profile questions that delegate matching compares.
//
// Only multiple-choice answers are used. Free-text answers never are.
// Each entry names the profile field it reads and how two answers are compared.
// Adding a brand-new question needs a change here.
// Changing which questions count, and in what order, is a per-event setting (see settings.ts).
//
// Pure, so it can be tested without the database or Cvent.
// ---------------------------------------------------------------------------

/** The id of one matchable question. Stored in the per-event matching settings. */
export type QuestionId =
    | "one_to_one_interests"
    | "current_focus_topics"
    | "initiative_priority"
    | "systems_and_platforms"
    | "transformation_stage"
    | "company_size"
    | "budget_responsibility";

/**
 * How two delegates' answers to a question are compared.
 * - shared_choices: multi-answer questions, scored by how many choices both picked.
 * - same_answer: single-answer questions, scored only when both gave the same answer.
 * - closeness: banded single answers, scored by how close the two bands are.
 */
export type Comparison = "shared_choices" | "same_answer" | "closeness";

/** One band question read by a closeness comparison. */
export type BandField = {
    /** Keys the event's ordered band list in AnswerScales. */
    scale: string;
    /** Reads the delegate's band, or null when they didn't answer. */
    read: (p: AttendeeProfile) => string | null;
};

/** One matchable question. */
export type MatchQuestion = {
    id: QuestionId;
    /** The question as admins see it on Matching Settings. */
    label: string;
    /** A short name for explanations, for example "company size". */
    shortLabel: string;
    /** The Salesforce fields it reads, without the CventEvents_NP_ prefix and __c suffix. */
    fields: string[];
    compare: Comparison;
    /** Reads the delegate's choices, for shared_choices and same_answer questions. */
    readChoices?: (p: AttendeeProfile) => string[];
    /** The bands it compares, for closeness questions. */
    bands?: BandField[];
};

/**
 * Wraps a single answer as a list, so single and multi-answer questions read the same way.
 *
 * @param {string | null} value - The answer.
 * @returns {string[]} The answer in a list, or an empty list.
 */
function one(value: string | null): string[] {
    return value ? [value] : [];
}

/**
 * The transformation stages, from least to most advanced, exactly as the Networking Profile form words them.
 * The form's stage names carry no numbers, so their order is listed here.
 * A stage missing from this list only matches the same stage.
 */
export const TRANSFORMATION_STAGE_ORDER = [
    "No active initiatives",
    "Early planning",
    "Piloting in key areas",
    "Scaling across functions",
    "Embedded in core operations",
];

/** Every matchable question, in the order the spec lists them. */
export const MATCH_QUESTIONS: MatchQuestion[] = [
    {
        id: "one_to_one_interests",
        label: "Areas of interest for one-to-ones",
        shortLabel: "one-to-one interests",
        fields: ["One_to_One_Interests"],
        compare: "shared_choices",
        readChoices: (p) => p.meetingInterests,
    },
    {
        id: "current_focus_topics",
        label: "Topics closest to your current focus",
        shortLabel: "focus topics",
        fields: ["Current_Focus_Topics"],
        compare: "shared_choices",
        readChoices: (p) => p.interestAreas,
    },
    {
        id: "initiative_priority",
        label: "One initiative you'd fund in 24 months",
        shortLabel: "initiative to fund",
        fields: ["Initiative_Priority"],
        compare: "same_answer",
        readChoices: (p) => one(p.priorityInitiative),
    },
    {
        id: "systems_and_platforms",
        label: "Systems and platforms you use today",
        shortLabel: "systems and platforms",
        fields: ["Systems_and_Platforms"],
        compare: "shared_choices",
        readChoices: (p) => p.systemsAndPlatforms,
    },
    {
        id: "transformation_stage",
        label: "Transformation stage",
        shortLabel: "transformation stage",
        fields: ["Transformation_Stage"],
        compare: "closeness",
        bands: [{ scale: "transformation_stage", read: (p) => p.transformationStage }],
    },
    {
        id: "company_size",
        label: "Company size (employees and revenue together)",
        shortLabel: "company size",
        fields: ["Company_Size", "Annual_Revenue"],
        compare: "closeness",
        bands: [
            { scale: "company_size", read: (p) => p.companySize },
            { scale: "annual_revenue", read: (p) => p.annualRevenue },
        ],
    },
    {
        id: "budget_responsibility",
        label: "Personal budget responsibility",
        shortLabel: "budget responsibility",
        fields: ["Budget_Responsibility"],
        compare: "closeness",
        bands: [{ scale: "budget_responsibility", read: (p) => p.budgetaryResponsibility }],
    },
];

/** Every question id, in MATCH_QUESTIONS order. */
export const QUESTION_IDS: QuestionId[] = MATCH_QUESTIONS.map((q) => q.id);

/** The questions by id. */
export const QUESTION_BY_ID = new Map(MATCH_QUESTIONS.map((q) => [q.id, q]));

/**
 * Whether a value is a matchable question id.
 *
 * @param {unknown} value - The value to check.
 * @returns {boolean} True when it names a question in MATCH_QUESTIONS.
 */
export function isQuestionId(value: unknown): value is QuestionId {
    return typeof value === "string" && QUESTION_BY_ID.has(value as QuestionId);
}

/**
 * Keeps only real answers.
 * Blanks and non-answers such as "Undisclosed" or "Other" never count as shared.
 *
 * @param {string[]} values - The raw answers.
 * @returns {string[]} The trimmed, informative answers, each once.
 */
export function informative(values: string[]): string[] {
    const out: string[] = [];
    for (const v of values) {
        const t = (v ?? "").trim();
        if (!t || isNonAnswer(t) || out.includes(t)) continue;
        out.push(t);
    }
    return out;
}

/**
 * Each band question's answers in order, smallest first, keyed by BandField.scale.
 * Closeness is measured by how far apart two answers are in this order.
 */
export type AnswerScales = Map<string, string[]>;

/**
 * Builds the band orders from the answers the event's delegates gave.
 * Number bands such as company size and revenue are ordered by the number they start at.
 * Transformation stages use TRANSFORMATION_STAGE_ORDER, with unlisted stages left off.
 *
 * @param {AttendeeProfile[]} profiles - The delegates' profiles.
 * @returns {AnswerScales} The ordered answers per band.
 */
export function buildAnswerScales(profiles: AttendeeProfile[]): AnswerScales {
    const scales: AnswerScales = new Map();
    for (const q of MATCH_QUESTIONS) {
        for (const band of q.bands ?? []) {
            if (band.scale === "transformation_stage") {
                scales.set(band.scale, TRANSFORMATION_STAGE_ORDER);
                continue;
            }
            const values = informative(profiles.map((p) => band.read(p) ?? ""));
            scales.set(band.scale, orderValues(values));
        }
    }
    return scales;
}

/**
 * How many matchable questions a delegate answered.
 * Of two equally good matches, the delegate who answered more is preferred.
 *
 * @param {AttendeeProfile} p - The delegate's profile.
 * @returns {number} The count, from 0 to the number of questions.
 */
export function answeredCount(p: AttendeeProfile): number {
    let n = 0;
    for (const q of MATCH_QUESTIONS) {
        const answered = q.bands
            ? q.bands.some((b) => informative([b.read(p) ?? ""]).length > 0)
            : informative(q.readChoices?.(p) ?? []).length > 0;
        if (answered) n++;
    }
    return n;
}
