// ---------------------------------------------------------------------------
// Value formatters shared by the mock→formFields mapping (lib/attendees/loader)
// and the Account-derived Industries field (lib/salesforce/attendeeMapper).
// ---------------------------------------------------------------------------

/**
 * Converts a raw annual revenue number to the display tier string used by the
 * filter UI. Returns the value as-is if it is already a string (e.g. already
 * formatted), or null if the input is null/undefined.
 */
export function formatRevenue(n: number | string | null): string | null {
    if (n === null || n === undefined) return null;
    if (typeof n === 'string') return n;
    if (n < 10_000_000) return '<10M';
    if (n < 50_000_000) return '10M-50M';
    if (n < 100_000_000) return '50M-100M';
    if (n < 500_000_000) return '100M-500M';
    if (n < 1_000_000_000) return '500M-1B';
    if (n < 5_000_000_000) return '1B-5B';
    return '>5B';
}

/**
 * Converts a raw employee count to the display tier string used by the filter
 * UI. Returns the value as-is if it is already a string, or null if the input
 * is null/undefined.
 */
export function formatCompanySize(n: number | string | null): string | null {
    if (n === null || n === undefined) return null;
    if (typeof n === 'string') return n;
    if (n <= 50) return '1-50';
    if (n <= 200) return '51-200';
    if (n <= 500) return '200-500';
    if (n <= 1000) return '500-1000';
    if (n <= 5000) return '1000-5000';
    return '>5000';
}

/**
 * Splits semicolon-delimited values that Salesforce packs into a single array
 * element (e.g. ["Healthcare;Pharmaceuticals"]) into individual strings.
 */
export function formatIndustrySectors(raw: string[]): string[] {
    return raw.flatMap(s => s.split(';').map(v => v.trim())).filter(Boolean);
}
