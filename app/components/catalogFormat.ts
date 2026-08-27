// ---------------------------------------------------------------------------
// Shared formatting helpers for the sponsor catalog UI.
//
// Pure, presentational helpers used across the catalog's views (SponsorCatalog)
// and the delegate details modal (DetailsModal). Kept here so both files draw
// on one implementation rather than duplicating them.
// ---------------------------------------------------------------------------

/**
 * Annual-revenue tiers, smallest → largest. The index drives the `rev-N`
 * color-coding class (see revClass) and the revenue sort order.
 */
export const REV_TIERS = [
    "<10M",
    "10M-50M",
    "50M-100M",
    "100M-500M",
    "500M-1B",
    "1B-5B",
    ">5B",
];

/**
 * Maps a revenue value to its `rev-N` color class (1-based tier index), or ""
 * when the value is empty or unrecognized.
 *
 * @param {string | number | null | undefined} val - The revenue tier value.
 * @returns {string} The `rev-N` class, or "".
 */
export function revClass(val: string | number | null | undefined): string {
    if (!val) return "";
    const i = REV_TIERS.indexOf(String(val));
    return i >= 0 ? `rev-${i + 1}` : "";
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
 * Returns true if a scalar profile value should be shown on a card.
 *
 * @param {unknown} v - The value.
 * @returns {boolean} Whether the value is present.
 */
export function hasValue(v: unknown): boolean {
    return v != null && v !== "";
}
