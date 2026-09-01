import { describe, test, expect } from "vitest";
import {
    orderValues,
    revClass,
    dotTags,
    shortTags,
    shortenValue,
    str,
    hasValue,
} from "./catalogFormat";

// ---------------------------------------------------------------------------
// orderValues — the ordering the whole catalog leans on.
//
// Delegate profile values are intake-form text rather than a fixed picklist, so
// filter options, sort order and revenue chip grading are all derived from
// whatever wording the form happens to use. These tests pin the behavior for the
// wordings a form realistically produces.
// ---------------------------------------------------------------------------

describe("orderValues", () => {
    // The exact wordings the live BMWS intake answers use.
    test("orders the live revenue bands", () => {
        expect(
            orderValues(["$5B–$10B", "Under $500M", "$500M–$1B"]),
        ).toEqual(["Under $500M", "$500M–$1B", "$5B–$10B"]);
    });

    test("orders the live budget bands", () => {
        expect(
            orderValues(["$1M–$5M", "Under $500k", "$500k–$1M"]),
        ).toEqual(["Under $500k", "$500k–$1M", "$1M–$5M"]);
    });

    test("orders the live company-size bands", () => {
        expect(
            orderValues(["5,000–25,000", "Under 1,000", "1,000–5,000"]),
        ).toEqual(["Under 1,000", "1,000–5,000", "5,000–25,000"]);
    });

    test('does not read "over" out of the middle of a word', () => {
        // "Discovery" contains "over"; it must not be treated as an upper bound
        // and sorted after an identically-bounded value.
        expect(orderValues(["$1M Discovery", "$1M–$5M"])).toEqual([
            "$1M Discovery",
            "$1M–$5M",
        ]);
    });

    test("orders currency bands by magnitude, not alphabetically", () => {
        expect(
            orderValues([
                "$250M–$1B",
                "Less than $50M",
                "More than $10B",
                "$1B–$10B",
                "$50M–$250M",
            ]),
        ).toEqual([
            "Less than $50M",
            "$50M–$250M",
            "$250M–$1B",
            "$1B–$10B",
            "More than $10B",
        ]);
    });

    test("orders headcount bands, ignoring thousands separators", () => {
        expect(
            orderValues([
                "More than 5,000",
                "1–50",
                "1,001–5,000",
                "251–1,000",
                "51–250",
            ]),
        ).toEqual([
            "1–50",
            "51–250",
            "251–1,000",
            "1,001–5,000",
            "More than 5,000",
        ]);
    });

    test('breaks ties on a shared bound: "under X" sorts before X, "X+" after', () => {
        expect(orderValues(["$10M+", "$10M–$50M", "Under $10M"])).toEqual([
            "Under $10M",
            "$10M–$50M",
            "$10M+",
        ]);
    });

    test("understands k / m / b / bn magnitude suffixes", () => {
        expect(
            orderValues(["1.5bn", "500k", "2 trillion", "$750M"]),
        ).toEqual(["500k", "$750M", "1.5bn", "2 trillion"]);
    });

    test("sorts unparseable values alphabetically, after the numeric ones", () => {
        expect(
            orderValues(["Scaling up", "$10M–$50M", "Exploring options"]),
        ).toEqual(["$10M–$50M", "Exploring options", "Scaling up"]);
    });

    test("handles the all-text case (e.g. transformation stages)", () => {
        expect(orderValues(["Piloting", "Exploring options"])).toEqual([
            "Exploring options",
            "Piloting",
        ]);
    });

    test("does not mutate its input", () => {
        const input = ["$1B–$10B", "Less than $50M"];
        orderValues(input);
        expect(input).toEqual(["$1B–$10B", "Less than $50M"]);
    });

    test("returns an empty array for no values", () => {
        expect(orderValues([])).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// revClass — grades a revenue value against the event's own bands.
// ---------------------------------------------------------------------------

describe("revClass", () => {
    const ordered = ["Under $500M", "$500M–$1B", "$5B–$10B"];

    test("spreads a few bands across the whole palette", () => {
        // The palette runs dark (rev-1) → light (rev-7). Three bands must not
        // collapse onto rev-1/2/3, which are three near-identical dark purples.
        expect(revClass("Under $500M", ordered)).toBe("rev-1");
        expect(revClass("$500M–$1B", ordered)).toBe("rev-4");
        expect(revClass("$5B–$10B", ordered)).toBe("rev-7");
    });

    test("keeps the extremes pinned for two bands", () => {
        const two = ["Under $500M", "$5B–$10B"];
        expect(revClass("Under $500M", two)).toBe("rev-1");
        expect(revClass("$5B–$10B", two)).toBe("rev-7");
    });

    test("puts a lone band mid-palette rather than implying lowest", () => {
        expect(revClass("$500M–$1B", ["$500M–$1B"])).toBe("rev-4");
    });

    test("spreads more bands than classes across the full palette", () => {
        // Ten bands, seven classes: lowest is still rev-1, highest still rev-7.
        const many = Array.from({ length: 10 }, (_, i) => `band-${i}`);
        expect(revClass("band-0", many)).toBe("rev-1");
        expect(revClass("band-9", many)).toBe("rev-7");
    });

    test('returns "" for an empty value so callers fall back to rev-na', () => {
        expect(revClass(null, ordered)).toBe("");
        expect(revClass(undefined, ordered)).toBe("");
        expect(revClass("", ordered)).toBe("");
    });

    test('returns "" for a value absent from the ordered list', () => {
        expect(revClass("$900T", ordered)).toBe("");
    });
});

// ---------------------------------------------------------------------------
// shortenValue / shortTags — keeping the long intake topics inside a column.
// ---------------------------------------------------------------------------

describe("shortenValue", () => {
    test("drops the elaboration after the colon", () => {
        expect(
            shortenValue(
                "Leadership Development: Building the Pipeline from Emerging Leader to Executive",
                40,
            ),
        ).toBe("Leadership Development");
    });

    test("caps the label at the maximum, ellipsis included", () => {
        const out = shortenValue(
            "Talent Mobility & Succession Planning: Building Bench Strength Before You Need It",
        );
        expect(out).toBe("Talent Mobility & S…");
        expect(out.length).toBeLessThanOrEqual(20);
    });

    test("leaves a short label untouched", () => {
        expect(shortenValue("Data & Insights: Proving L&D's ROI")).toBe(
            "Data & Insights",
        );
    });

    test("never ends on dangling punctuation before the ellipsis", () => {
        // Cutting "Coaching & Mentorship Programs" at 19 chars would land on
        // "Coaching & Mentorsh" — fine — but a cut landing on "&" or "," must
        // not produce "Coaching &…" style trailing junk beyond the conjunction.
        expect(shortenValue("A, B, C, D, E, F, G, H, I, J")).not.toMatch(/[\s,;&/-]…$/);
    });

    test("handles a value with no colon at all", () => {
        expect(shortenValue("Organizational Development")).toBe(
            "Organizational Deve…",
        );
    });

    test("respects a caller-supplied maximum", () => {
        expect(shortenValue("Leadership Development", 12)).toBe("Leadership…");
    });
});

describe("shortTags", () => {
    test("shortens each value and dot-joins them", () => {
        expect(
            shortTags([
                "Data & Insights: Proving L&D's ROI and Business Impact",
                "Leadership Development: Building the Pipeline",
            ]),
        ).toBe("Data & Insights · Leadership Developm…");
    });

    test("tolerates empty input like dotTags", () => {
        expect(shortTags([])).toBe("");
        expect(shortTags(null)).toBe("");
    });
});

// ---------------------------------------------------------------------------
// Small display helpers.
// ---------------------------------------------------------------------------

describe("dotTags / str / hasValue", () => {
    test("dotTags joins with a middot and tolerates empty input", () => {
        expect(dotTags(["cloud", "AI/ML"])).toBe("cloud · AI/ML");
        expect(dotTags([])).toBe("");
        expect(dotTags(null)).toBe("");
    });

    test('str falls back to "N/A" for null', () => {
        expect(str("Scaling up")).toBe("Scaling up");
        expect(str(null)).toBe("N/A");
    });

    test("hasValue treats an empty array as absent", () => {
        expect(hasValue(["a"])).toBe(true);
        expect(hasValue([])).toBe(false);
        expect(hasValue("x")).toBe(true);
        expect(hasValue("")).toBe(false);
        expect(hasValue(null)).toBe(false);
    });
});
