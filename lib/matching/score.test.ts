import { describe, expect, test } from "vitest";
import type { AttendeeProfile } from "@/types";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import {
    bandCloseness,
    explainGroup,
    explainMatch,
    groupSharedAnswers,
    scoreAgainstGroup,
    scorePair,
} from "./score";
import { answeredCount, buildAnswerScales } from "./questions";
import { DEFAULT_QUESTIONS, type QuestionSetting } from "./settings";

// ---------------------------------------------------------------------------
// Match scoring and explanations.
// ---------------------------------------------------------------------------

/**
 * Builds a delegate profile with only the given answers.
 *
 * @param {Partial<AttendeeProfile>} partial - The answers to set.
 * @returns {AttendeeProfile} The profile.
 */
function profile(partial: Partial<AttendeeProfile>): AttendeeProfile {
    return { ...emptyProfile(), ...partial };
}

const NO_SCALES = buildAnswerScales([]);

describe("scorePair", () => {
    test("criterion 3: sharing more answers on higher-priority questions scores higher than sharing fewer", () => {
        const a = profile({ meetingInterests: ["Leadership Development", "Coaching"], systemsAndPlatforms: ["Workday"] });
        const more = profile({ meetingInterests: ["Leadership Development", "Coaching"], systemsAndPlatforms: ["Workday"] });
        const fewer = profile({ meetingInterests: ["Leadership Development", "Onboarding"], systemsAndPlatforms: ["Oracle"] });
        expect(scorePair(a, more, DEFAULT_QUESTIONS, NO_SCALES).score).toBeGreaterThan(
            scorePair(a, fewer, DEFAULT_QUESTIONS, NO_SCALES).score,
        );
    });

    test("criterion 3: the same single share counts for more on a higher-priority question", () => {
        const a = profile({ meetingInterests: ["Leadership Development"], systemsAndPlatforms: ["Workday"] });
        const sharesTop = profile({ meetingInterests: ["Leadership Development"], systemsAndPlatforms: ["Oracle"] });
        const sharesLower = profile({ meetingInterests: ["Onboarding"], systemsAndPlatforms: ["Workday"] });
        expect(scorePair(a, sharesTop, DEFAULT_QUESTIONS, NO_SCALES).score).toBeGreaterThan(
            scorePair(a, sharesLower, DEFAULT_QUESTIONS, NO_SCALES).score,
        );
    });

    test("criterion 2: turning a question off removes it from scoring", () => {
        const a = profile({ systemsAndPlatforms: ["Workday"] });
        const b = profile({ systemsAndPlatforms: ["Workday"] });
        const off: QuestionSetting[] = DEFAULT_QUESTIONS.map((q) =>
            q.id === "systems_and_platforms" ? { ...q, enabled: false } : q,
        );
        expect(scorePair(a, b, DEFAULT_QUESTIONS, NO_SCALES).score).toBeGreaterThan(0);
        expect(scorePair(a, b, off, NO_SCALES)).toEqual({ score: 0, shared: [] });
    });

    test("criterion 2: moving a question up raises how much it counts", () => {
        const a = profile({ systemsAndPlatforms: ["Workday"] });
        const b = profile({ systemsAndPlatforms: ["Workday"] });
        const moved: QuestionSetting[] = [
            { id: "systems_and_platforms", enabled: true },
            ...DEFAULT_QUESTIONS.filter((q) => q.id !== "systems_and_platforms"),
        ];
        expect(scorePair(a, b, moved, NO_SCALES).score).toBeGreaterThan(
            scorePair(a, b, DEFAULT_QUESTIONS, NO_SCALES).score,
        );
    });

    test("criterion 4: 'Undisclosed', 'Other' and blank answers never count as shared", () => {
        const a = profile({
            meetingInterests: ["Other", "  "],
            priorityInitiative: "Undisclosed",
            companySize: "Undisclosed",
            systemsAndPlatforms: ["other"],
        });
        const b = profile({
            meetingInterests: ["Other"],
            priorityInitiative: "Undisclosed",
            companySize: "Undisclosed",
            systemsAndPlatforms: ["Other"],
        });
        expect(scorePair(a, b, DEFAULT_QUESTIONS, NO_SCALES)).toEqual({ score: 0, shared: [] });
    });

    test("criterion 4: free-text fields are not read, only the multiple-choice answers", () => {
        // Industry sectors and job titles aren't matchable questions, so sharing them gives nothing.
        const a = profile({ industrySectors: ["Healthcare"] });
        const b = profile({ industrySectors: ["Healthcare"] });
        expect(scorePair(a, b, DEFAULT_QUESTIONS, NO_SCALES).score).toBe(0);
    });

    test("criterion 5: the explanation lists exactly the shared answers that gave points", () => {
        const a = profile({
            meetingInterests: ["Leadership Development", "Coaching"],
            systemsAndPlatforms: ["Workday", "Go1"],
            priorityInitiative: "Onboarding Experience Redesign",
        });
        const b = profile({
            meetingInterests: ["Leadership Development"],
            systemsAndPlatforms: ["Workday", "Oracle"],
            priorityInitiative: "Skills Taxonomy",
        });
        const result = scorePair(a, b, DEFAULT_QUESTIONS, NO_SCALES);
        expect(result.shared.map((s) => [s.questionId, s.values])).toEqual([
            ["one_to_one_interests", ["Leadership Development"]],
            ["systems_and_platforms", ["Workday"]],
        ]);
        expect(result.shared.every((s) => s.points > 0)).toBe(true);
        expect(explainMatch(result.shared)).toBe("Both: Leadership Development, Workday.");
    });

    test("compares company size by how close both bands are", () => {
        const sizes = [
            profile({ companySize: "Under 1,000", annualRevenue: "Under $500M" }),
            profile({ companySize: "1,000–5,000", annualRevenue: "$500M–$1B" }),
            profile({ companySize: "5,000–25,000", annualRevenue: "$5B–$10B" }),
        ];
        const scales = buildAnswerScales(sizes);
        const same = scorePair(sizes[0], sizes[0], DEFAULT_QUESTIONS, scales);
        const near = scorePair(sizes[0], sizes[1], DEFAULT_QUESTIONS, scales);
        const far = scorePair(sizes[0], sizes[2], DEFAULT_QUESTIONS, scales);
        expect(same.score).toBeGreaterThan(near.score);
        expect(near.score).toBeGreaterThan(far.score);
        expect(far.score).toBe(0);
        expect(explainMatch(same.shared)).toBe("Same company size.");
        expect(explainMatch(near.shared)).toBe("Similar company size.");
    });
});

describe("bandCloseness", () => {
    test("gives 1 for the same band, 0.5 for a neighbour and 0 further apart", () => {
        const order = ["a", "b", "c"];
        expect(bandCloseness("b", "b", order)).toBe(1);
        expect(bandCloseness("a", "b", order)).toBe(0.5);
        expect(bandCloseness("a", "c", order)).toBe(0);
        expect(bandCloseness("a", "zzz", order)).toBe(0);
    });
});

describe("answeredCount", () => {
    test("counts the matchable questions a delegate answered", () => {
        expect(answeredCount(emptyProfile())).toBe(0);
        expect(answeredCount(profile({ meetingInterests: ["X"], annualRevenue: "Under $500M" }))).toBe(2);
        expect(answeredCount(profile({ priorityInitiative: "Undisclosed" }))).toBe(0);
    });
});

describe("groups", () => {
    const members = [
        profile({ meetingInterests: ["Leadership Development", "Coaching"], systemsAndPlatforms: ["Workday"] }),
        profile({ meetingInterests: ["Leadership Development"], systemsAndPlatforms: ["Workday"] }),
        profile({ meetingInterests: ["Leadership Development", "Coaching"], systemsAndPlatforms: ["Go1"] }),
    ];

    test("scores a delegate against a group as the average of their pair scores", () => {
        const candidate = profile({ meetingInterests: ["Leadership Development"] });
        const pairs = members.map((m) => scorePair(candidate, m, DEFAULT_QUESTIONS, NO_SCALES).score);
        const group = scoreAgainstGroup(candidate, members, DEFAULT_QUESTIONS, NO_SCALES);
        expect(group.score).toBe(Math.round(pairs.reduce((a, b) => a + b, 0) / pairs.length));
        expect(group.shared.map((s) => s.values)).toEqual([["Leadership Development"]]);
        expect(scoreAgainstGroup(candidate, [], DEFAULT_QUESTIONS, NO_SCALES)).toEqual({ score: 0, shared: [] });
    });

    test("summarizes the answers at least two members share", () => {
        const answers = groupSharedAnswers(members, DEFAULT_QUESTIONS);
        expect(explainGroup(answers)).toBe("Leadership Development (3), Coaching (2), Workday (2)");
        expect(explainGroup([])).toBe("Nothing in common yet.");
    });
});
