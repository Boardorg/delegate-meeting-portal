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

/**
 * Formats an ISO 8601 UTC string as a short time, e.g. "9:00 AM", in a given
 * IANA timezone. Pass the event's real timezone (from
 * lib/cvent/mapper.ts's EventScheduleData.timezone) so display matches the
 * venue's local time regardless of the viewer's own timezone. Defaults to UTC
 * only as a fallback for callers that don't have an event timezone in scope.
 *
 * @param {string | null} iso - ISO 8601 string, or null.
 * @param {string} [timeZone] - IANA timezone to display in. Defaults to "UTC".
 * @returns {string} Formatted time, or "—" for null.
 */
export function fmtTime(iso: string | null, timeZone: string = "UTC"): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone,
    });
}

/**
 * Formats an ISO 8601 UTC string as a lowercase weekday name (e.g. "monday")
 * in a given IANA timezone. Like fmtTime, pass the event's real timezone so the
 * day matches the venue's local calendar rather than the viewer's. Defaults to
 * UTC as a fallback.
 *
 * @param {string | null} iso - ISO 8601 string, or null.
 * @param {string} [timeZone] - IANA timezone to resolve the day in. Defaults to "UTC".
 * @returns {string} Lowercase weekday name, or "—" for null.
 */
export function fmtWeekday(
    iso: string | null,
    timeZone: string = "UTC",
): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-US", {
        weekday: "long",
        timeZone,
    });
}
