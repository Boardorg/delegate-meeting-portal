// ---------------------------------------------------------------------------
// Shared formatting helpers for the sponsor catalog UI.
//
// Pure, presentational helper used across the catalog's views (SponsorCatalog)
// and the delegate details modal (DetailsModal). Kept here so both files draw
// on one implementation rather than duplicating it.
// ---------------------------------------------------------------------------

/**
 * Joins a list of values into a dot-separated string (e.g. "cloud · AI/ML"), or
 * "" when the list is empty/absent. Used to render a form field's selected
 * value(s) — single- and multi-select alike.
 *
 * @param {string[] | null | undefined} arr - The values.
 * @returns {string} The joined string, or "".
 */
export function dotTags(arr: string[] | null | undefined): string {
    return (arr || []).join(" · ");
}
