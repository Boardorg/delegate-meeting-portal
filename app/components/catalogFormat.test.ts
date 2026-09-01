import { describe, test, expect } from "vitest";
import { orderValues, revClass, dotTags, str, hasValue } from "./catalogFormat";

// ---------------------------------------------------------------------------
// orderValues — the ordering the whole catalog leans on.
//
// Delegate profile values are intake-form text rather than a fixed picklist, so
// filter options, sort order and revenue chip grading are all derived from
// whatever wording the form happens to use. These tests pin the behavior for the
// wordings a form realistically produces.
// ---------------------------------------------------------------------------

describe("orderValues", () => {
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
    const ordered = ["Less than $50M", "$50M–$250M", "$1B–$10B"];

    test("assigns one class per band when they fit the palette", () => {
        expect(revClass("Less than $50M", ordered)).toBe("rev-1");
        expect(revClass("$50M–$250M", ordered)).toBe("rev-2");
        expect(revClass("$1B–$10B", ordered)).toBe("rev-3");
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
