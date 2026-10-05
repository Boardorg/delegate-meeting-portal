import { describe, test, expect } from "vitest";
import {
    orderValues,
    revClass,
    dotTags,
    shortTags,
    shortenValue,
    tagColorClass,
    DETAILS_TAG_MAX,
    SHORT_TAG_MAX,
    TAG_COLOR_COUNT,
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

// The real BMWS focus-topic answers, used by several cases below.
const LIVE_TOPICS = [
    "L&D Strategy & Resourcing: Aligning Learning Investment to Business Outcomes",
    "Data & Insights: Proving L&D's ROI and Business Impact",
    "Talent Mobility & Succession Planning: Building Bench Strength Before You Need It",
    "Coaching & Mentorship Programs: Scaling 1:1 Development Beyond the Executive Suite",
    "Leadership Development: Building the Pipeline from Emerging Leader to Executive",
    "Professional Development & Skills: Moving to Skills-Based Career Frameworks",
    "Onboarding & New-to-Role Learning: Getting New Hires and New Managers Productive Faster",
    "Learning Design & Delivery: Engaging Time-Constrained, Distracted Learners at Scale",
];

describe("shortenValue", () => {
    test("truncates to the maximum, ellipsis included", () => {
        const out = shortenValue(
            "Talent Mobility & Succession Planning: Building Bench Strength Before You Need It",
        );
        expect(out).toBe("Talent Mobility & S…");
        expect(out.length).toBe(SHORT_TAG_MAX);
    });

    test("leaves a value shorter than the maximum untouched", () => {
        expect(shortenValue("Data & Insights")).toBe("Data & Insights");
        expect(shortenValue("Go1")).toBe("Go1");
    });

    test("keeps a colon like any other character", () => {
        expect(shortenValue("Data & Insights: Proving L&D's ROI")).toBe(
            "Data & Insights: Pr…",
        );
    });

    test("does not leave a gap before the ellipsis when the cut lands on a space", () => {
        expect(shortenValue("Leadership Development", 12)).toBe("Leadership…");
        expect(shortenValue("Organizational Development")).toBe(
            "Organizational Deve…",
        );
    });

    test("respects a caller-supplied maximum", () => {
        const out = shortenValue("Learning Governance & Team Structure", 15);
        expect(out).toBe("Learning Gover…");
        expect(out.length).toBeLessThanOrEqual(15);
    });

    test("the details modal gets a bigger budget than the compact views", () => {
        // The exact multiple is a tuning knob; what the modal relies on is only
        // that it has strictly more room than a list column.
        expect(DETAILS_TAG_MAX).toBeGreaterThan(SHORT_TAG_MAX);
    });

    test("never exceeds the budget for any live answer, at either length", () => {
        for (const v of LIVE_TOPICS) {
            expect(shortenValue(v).length).toBeLessThanOrEqual(SHORT_TAG_MAX);
            expect(shortenValue(v, DETAILS_TAG_MAX).length).toBeLessThanOrEqual(
                DETAILS_TAG_MAX,
            );
        }
    });

    test("the details budget tells apart answers sharing a long opening", () => {
        // These two collide at 20 chars but not at 40 — the reason the modal
        // gets the longer budget.
        const a = "Onboarding & New-to-Role Learning: Getting New Hires";
        const b = "Onboarding & New-to-Career Learning: Getting Started";
        expect(shortenValue(a)).toBe(shortenValue(b));
        expect(shortenValue(a, DETAILS_TAG_MAX)).not.toBe(
            shortenValue(b, DETAILS_TAG_MAX),
        );
    });
});

describe("shortTags", () => {
    test("shortens each value and dot-joins them", () => {
        expect(
            shortTags([
                "Data & Insights: Proving L&D's ROI and Business Impact",
                "Leadership Development: Building the Pipeline",
            ]),
        ).toBe("Data & Insights: Pr… · Leadership Developm…");
    });

    test("tolerates empty input like dotTags", () => {
        expect(shortTags([])).toBe("");
        expect(shortTags(null)).toBe("");
    });
});

// ---------------------------------------------------------------------------
// tagColorClass — a stable categorical color per interest area.
// ---------------------------------------------------------------------------

describe("tagColorClass", () => {
    const order = ["Coaching", "Data & Insights", "Leadership", "Onboarding"];

    test("gives adjacent options different colors", () => {
        const classes = order.map((v) => tagColorClass(v, order));
        expect(new Set(classes).size).toBe(order.length);
    });

    test("gives a value the same color every time (pill ↔ sidebar swatch)", () => {
        expect(tagColorClass("Leadership", order)).toBe(
            tagColorClass("Leadership", order),
        );
        expect(tagColorClass("Leadership", order)).toBe("tag-c3");
    });

    test("wraps around once the options outnumber the palette", () => {
        const many = Array.from({ length: 20 }, (_, i) => `v${i}`);
        expect(tagColorClass("v0", many)).toBe("tag-c1");
        expect(tagColorClass(`v${TAG_COLOR_COUNT}`, many)).toBe("tag-c1");
    });

    test("falls back to a stable hash for a value outside the list", () => {
        const a = tagColorClass("Not listed", order);
        expect(a).toMatch(/^tag-c[1-8]$/);
        expect(tagColorClass("Not listed", order)).toBe(a);
    });

    test("always returns a class within the defined palette", () => {
        for (const v of [...order, "x", "", "a very long value indeed"]) {
            const n = Number(tagColorClass(v, order).replace("tag-c", ""));
            expect(n).toBeGreaterThanOrEqual(1);
            expect(n).toBeLessThanOrEqual(TAG_COLOR_COUNT);
        }
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
