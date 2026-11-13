import { describe, expect, test } from "vitest";
import {
    DEFAULT_MATCHING_SETTINGS,
    parseMatchingSettings,
    questionWeights,
    resolveMatchingSettings,
    resolveQuestions,
} from "./settings";
import { QUESTION_IDS } from "./questions";

// ---------------------------------------------------------------------------
// Per-event matching settings and their defaults.
// ---------------------------------------------------------------------------

describe("resolveMatchingSettings", () => {
    test("criterion 1: with no saved settings, an event uses the default question order, caps, seats and alternates", () => {
        const s = resolveMatchingSettings(null);
        expect(s).toEqual(DEFAULT_MATCHING_SETTINGS);
        expect(s.d2d.questions.filter((q) => q.enabled).map((q) => q.id)).toEqual([
            "one_to_one_interests",
            "current_focus_topics",
            "systems_and_platforms",
            "company_size",
            "initiative_priority",
        ]);
        expect(s.d2d.questions.filter((q) => !q.enabled).map((q) => q.id)).toEqual([
            "transformation_stage",
            "budget_responsibility",
        ]);
        expect(s.d2d.capWithoutS2D).toBe(4);
        expect(s.d2d.capWithS2D).toBe(5);
        expect(s.roundtables.seatsPerTable).toBe(5);
        expect(s.roundtables.alternatesPerTable).toBe(2);
        expect(s.roundtables.questions).toEqual(s.d2d.questions);
    });

    test("fills in missing or bad parts from the defaults", () => {
        const s = resolveMatchingSettings({ d2d: { capWithS2D: 6, capWithoutS2D: -1 }, roundtables: { seatsPerTable: "7" } });
        expect(s.d2d.capWithS2D).toBe(6);
        expect(s.d2d.capWithoutS2D).toBe(4);
        expect(s.roundtables.seatsPerTable).toBe(5);
    });
});

describe("resolveQuestions", () => {
    test("drops unknown ids and repeats, and adds missing questions at the end turned off", () => {
        const qs = resolveQuestions([
            { id: "company_size", enabled: true },
            { id: "nope", enabled: true },
            { id: "company_size", enabled: false },
        ]);
        expect(qs[0]).toEqual({ id: "company_size", enabled: true });
        expect(qs).toHaveLength(QUESTION_IDS.length);
        expect(qs.slice(1).every((q) => !q.enabled)).toBe(true);
    });
});

describe("parseMatchingSettings", () => {
    test("accepts the defaults", () => {
        expect(parseMatchingSettings(DEFAULT_MATCHING_SETTINGS)).toEqual({
            ok: true,
            settings: DEFAULT_MATCHING_SETTINGS,
        });
    });

    test("refuses a number out of range, with a message", () => {
        const bad = {
            ...DEFAULT_MATCHING_SETTINGS,
            roundtables: { ...DEFAULT_MATCHING_SETTINGS.roundtables, seatsPerTable: 0 },
        };
        const result = parseMatchingSettings(bad);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("Seats per table");
    });

    test("refuses a question list that leaves a question out", () => {
        const bad = {
            ...DEFAULT_MATCHING_SETTINGS,
            d2d: { ...DEFAULT_MATCHING_SETTINGS.d2d, questions: DEFAULT_MATCHING_SETTINGS.d2d.questions.slice(1) },
        };
        expect(parseMatchingSettings(bad).ok).toBe(false);
    });
});

describe("questionWeights", () => {
    test("gives higher questions more weight and turned-off questions none", () => {
        const w = questionWeights([
            { id: "company_size", enabled: true },
            { id: "initiative_priority", enabled: false },
            { id: "one_to_one_interests", enabled: true },
        ]);
        expect(w.get("company_size")).toBe(2);
        expect(w.get("one_to_one_interests")).toBe(1);
        expect(w.has("initiative_priority")).toBe(false);
    });
});
