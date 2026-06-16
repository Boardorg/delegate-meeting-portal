// ---------------------------------------------------------------------------
// Display formatters shared by the admin tables.
// ---------------------------------------------------------------------------

/**
 * Formats a date as `m/d/yyyy`. Returns "—" for null so a never-set timestamp
 * (e.g. last-login) is obvious at a glance.
 *
 * @param {Date | null} d - The date, or null.
 * @returns {string} The formatted date, or "—".
 */
export function fmtDate(d: Date | null): string {
    if (!d) return "—";
    return d.toLocaleDateString("en-US", {
        month: "numeric",
        day: "numeric",
        year: "numeric",
    });
}

/**
 * Formats a timestamp as `m/d/yyyy, h:mm AM`.
 *
 * @param {Date} d - The timestamp.
 * @returns {string} The formatted date-time.
 */
export function fmtDateTime(d: Date): string {
    return d.toLocaleString("en-US", {
        month: "numeric",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}
