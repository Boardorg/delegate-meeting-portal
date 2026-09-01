// ---------------------------------------------------------------------------
// Shared formatting helpers for the sponsor catalog UI.
//
// Pure, presentational helpers used across the catalog's views (SponsorCatalog)
// and the delegate details modal (DetailsModal). Kept here so both files draw
// on one implementation rather than duplicating them.
//
// Note there are no hardcoded value lists here. Delegate profile values are
// intake-form text, not a fixed picklist, so the catalog's filter options, sort
// order and revenue color-coding are all derived from the loaded delegates via
// `orderValues` below.
// ---------------------------------------------------------------------------

/** How many `rev-N` color classes app/frontend.css defines (rev-1 … rev-7). */
const REV_CLASS_COUNT = 7;

// Multipliers for the magnitude suffixes that show up in revenue / budget
// answers ("$50M", "1.5bn", "500k").
const MAGNITUDE_SUFFIXES: Array<[RegExp, number]> = [
    [/^k\b/, 1e3],
    [/^m\b|^mm\b|^million\b/, 1e6],
    [/^bn\b|^b\b|^billion\b/, 1e9],
    [/^t\b|^trillion\b/, 1e12],
];

/**
 * Parses a rough numeric magnitude out of a free-text range answer so a set of
 * them can be ordered smallest → largest.
 *
 * Reads the FIRST number in the string and scales it by any magnitude suffix
 * that immediately follows, ignoring currency symbols and thousands separators.
 * So "Less than $10M" → 10e6, "$500M–$1B" → 500e6, "1,000–4,999 employees" →
 * 1000, "5,000+" → 5000.
 *
 * Ordering by the range's lower bound is what makes this work regardless of how
 * the intake form words its options: consecutive bands start at increasing
 * values whether they read "$10M–$50M" or "10 to 50 million".
 *
 * @param {string} value - The raw answer text.
 * @returns {number | null} The parsed magnitude, or null when no number is present.
 */
function parseMagnitude(value: string): number | null {
    // Strip currency symbols and thousands separators so "$1,500" reads as 1500.
    const cleaned = value.replace(/[$£€,]/g, "");

    const match = /(\d+(?:\.\d+)?)\s*([a-z]*)/i.exec(cleaned);
    if (!match) return null;

    const n = Number(match[1]);
    if (!Number.isFinite(n)) return null;

    // Scale by the suffix directly after the number, if it's one we recognize.
    const suffix = match[2].toLowerCase();
    for (const [pattern, multiplier] of MAGNITUDE_SUFFIXES) {
        if (pattern.test(suffix)) return n * multiplier;
    }
    return n;
}

/**
 * Sorts free-text range answers into a natural smallest → largest order.
 *
 * Values carrying a parseable number sort by that magnitude and come first;
 * anything unparseable (a stage name, a named initiative) falls back to
 * alphabetical and sorts after them. A leading "less than" / "<" nudges a value
 * ahead of an identical bound and a trailing "+" / "over" nudges it after, so
 * "<$10M" precedes "$10M–$50M".
 *
 * Used for both the sidebar filter option order and the sort-by-field order, so
 * the two always agree.
 *
 * @param {string[]} values - Distinct raw values.
 * @returns {string[]} A new, ordered array.
 */
export function orderValues(values: string[]): string[] {
    // Precompute each value's sort key once rather than inside the comparator.
    const keyed = values.map((value) => {
        const lower = value.toLowerCase();
        const magnitude = parseMagnitude(value);
        // Tie-break identically-bounded values: "under 10M" < "10M-50M" < "10M+".
        let bias = 0;
        if (/^(<|under\b|less than\b|up to\b|fewer than\b)/.test(lower.trim())) {
            bias = -1;
        } else if (/(\+|>|over\b|more than\b|or more\b)/.test(lower)) {
            bias = 1;
        }
        return { value, magnitude, bias };
    });

    return keyed
        .sort((a, b) => {
            // Numeric values first, ordered by magnitude then by bias.
            if (a.magnitude !== null && b.magnitude !== null) {
                if (a.magnitude !== b.magnitude) return a.magnitude - b.magnitude;
                if (a.bias !== b.bias) return a.bias - b.bias;
                return a.value.localeCompare(b.value);
            }
            if (a.magnitude !== null) return -1;
            if (b.magnitude !== null) return 1;
            return a.value.localeCompare(b.value);
        })
        .map((k) => k.value);
}

/**
 * Maps a revenue value to its `rev-N` color class by its rank within the
 * event's own ordered revenue values, or "" when the value is empty or absent
 * from that list.
 *
 * Ranking rather than matching a fixed tier table means the chips stay graded
 * across the full palette whatever wording — and however many bands — the intake
 * form uses. Callers keep the `revClass(…) || "rev-na"` idiom for the empty case.
 *
 * @param {string | null | undefined} val - The revenue value.
 * @param {string[]} ordered - The event's revenue values, ordered by orderValues.
 * @returns {string} The `rev-N` class, or "".
 */
export function revClass(
    val: string | null | undefined,
    ordered: string[],
): string {
    if (!val) return "";

    const i = ordered.indexOf(String(val));
    if (i < 0) return "";

    // One band per class when there are few, otherwise spread the bands evenly
    // across the palette so the lowest is always rev-1 and the highest rev-7.
    if (ordered.length <= REV_CLASS_COUNT) return `rev-${i + 1}`;
    const scaled = Math.round((i / (ordered.length - 1)) * (REV_CLASS_COUNT - 1));
    return `rev-${scaled + 1}`;
}

/**
 * Joins a tag list into a dot-separated string (e.g. "cloud · AI/ML"), or ""
 * when the list is empty/absent.
 *
 * @param {string[] | null | undefined} arr - The tag values.
 * @returns {string} The joined string, or "".
 */
export function dotTags(arr: string[] | null | undefined): string {
    return (arr || []).join(" · ");
}

/**
 * Renders a scalar profile value for display, falling back to "N/A" for null.
 *
 * @param {unknown} v - The value.
 * @returns {string} The stringified value, or "N/A".
 */
export function str(v: unknown): string {
    return v != null ? String(v) : "N/A";
}

/**
 * Returns true if a profile value should be shown on a card — non-empty for a
 * scalar, non-empty-array for a tag list.
 *
 * @param {unknown} v - The value.
 * @returns {boolean} Whether the value is present.
 */
export function hasValue(v: unknown): boolean {
    if (Array.isArray(v)) return v.length > 0;
    return v != null && v !== "";
}
