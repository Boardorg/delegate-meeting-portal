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
        // Tie-break identically-bounded values: "Under $500M" < "$500M–$1B", and
        // "$10M+" after "$10M–$50M". Word boundaries on both sides so a value
        // like "Discovery" isn't read as "over".
        let bias = 0;
        if (
            /^(<|under\b|less than\b|up to\b|fewer than\b)/.test(lower.trim())
        ) {
            bias = -1;
        } else if (/(\+|>|\bover\b|\bmore than\b|\bor more\b)/.test(lower)) {
            bias = 1;
        }
        return { value, magnitude, bias };
    });

    return keyed
        .sort((a, b) => {
            // Numeric values first, ordered by magnitude then by bias.
            if (a.magnitude !== null && b.magnitude !== null) {
                if (a.magnitude !== b.magnitude)
                    return a.magnitude - b.magnitude;
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
 * The bands are spread across the WHOLE palette rather than taking one class
 * each from the bottom up. rev-1…rev-7 runs dark→light, so an event with only
 * three revenue bands would otherwise get rev-1/2/3 — three near-identical dark
 * purples that read as broken. Spreading gives rev-1/rev-4/rev-7 instead, so the
 * lowest band is always the darkest and the highest always the lightest however
 * many bands the intake form offers.
 *
 * Callers keep the `revClass(…) || "rev-na"` idiom for the empty case.
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

    // A single band conveys no gradient, so sit it mid-palette rather than
    // implying "lowest".
    if (ordered.length === 1) return `rev-${Math.ceil(REV_CLASS_COUNT / 2)}`;

    const scaled = Math.round(
        (i / (ordered.length - 1)) * (REV_CLASS_COUNT - 1),
    );
    return `rev-${scaled + 1}`;
}

// Longest a single tag may render as in the compact views (grid card, list
// column, horizontal card). The intake form's topic answers run to 130+
// characters, which no column can carry; the full text stays in the sidebar
// filter and on each pill's tooltip.
export const SHORT_TAG_MAX = 20;

// The details modal gets a larger budget — it's a 440px panel rather than a
// ~110px column — which is also enough to tell apart answers that share a long
// opening phrase.
export const DETAILS_TAG_MAX = SHORT_TAG_MAX * 3;

/**
 * Shortens one long answer for display in a compact view: a straight character
 * cap, ellipsized when it doesn't fit. The full text stays available on the
 * pill's tooltip and in the sidebar filter's option list.
 *
 * @param {string} value - The full answer text.
 * @param {number} [max] - Maximum characters, ellipsis included.
 * @returns {string} The shortened label.
 */
export function shortenValue(
    value: string,
    max: number = SHORT_TAG_MAX,
): string {
    const text = value.trim();
    if (text.length <= max) return text;

    // trimEnd so a cut landing on a space doesn't leave a gap before the ellipsis.
    return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Joins a tag list for a compact view: each value shortened, then dot-separated.
 * Use `dotTags` where the full text should show (the details modal).
 *
 * @param {string[] | null | undefined} arr - The tag values.
 * @param {number} [max] - Maximum characters per value.
 * @returns {string} The joined, shortened string, or "".
 */
export function shortTags(
    arr: string[] | null | undefined,
    max: number = SHORT_TAG_MAX,
): string {
    return (arr || []).map((v) => shortenValue(v, max)).join(" · ");
}

/** How many categorical tag colors globals.css defines (--tag-1 … --tag-8). */
export const TAG_COLOR_COUNT = 8;

/**
 * Returns the `tag-cN` class that colors one tag value.
 *
 * Color comes from the value's position in the event's own ordered option list,
 * so a given interest area keeps the same color in every view and matches its
 * swatch in the sidebar filter, and adjacent options in that list never collide.
 * A value missing from the list (possible only if the two are computed from
 * different pools) falls back to a stable hash of its text rather than
 * defaulting everything to one color.
 *
 * @param {string} value - The tag value.
 * @param {string[]} order - The event's option list for this field.
 * @returns {string} A `tag-cN` class name.
 */
export function tagColorClass(value: string, order: string[]): string {
    let i = order.indexOf(value);
    if (i < 0) {
        // Cheap deterministic hash — only a fallback, so spread matters more
        // than distribution quality.
        i = 0;
        for (let c = 0; c < value.length; c++)
            i = (i * 31 + value.charCodeAt(c)) | 0;
        i = Math.abs(i);
    }
    return `tag-c${(i % TAG_COLOR_COUNT) + 1}`;
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
