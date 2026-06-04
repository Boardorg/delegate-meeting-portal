// ---------------------------------------------------------------------------
// Phone-number normalization
//
// Twilio Verify requires E.164 format (e.g. "+15555550123"). This helper does
// a minimal normalization.
// ---------------------------------------------------------------------------

/**
 * Coerces a user-entered phone number into E.164 form, or returns null if it
 * doesn't look like a phone number at all.
 *
 * Behavior:
 *  - "+4 (555) 555-0123" → "+45555550123"
 *  - "5555550123"        → "+15555550123" (caller-entered without a country code; we add it)
 *  - "abc"               → null
 *
 * @param {string} input - Raw user input from the login form.
 * @returns {string | null} The normalized E.164 number, or null on bad input.
 */
export function normalizePhone(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    //Assume a us country code if none provided
    const countryCode = trimmed.startsWith("+")
        ? trimmed.substring(0, 2)
        : "+1";

    // Strip everything that isn't a digit.
    const digits = trimmed.replace(/\D/g, "");

    // E.164 allows 8–15 digits.
    if (digits.length < 8 || digits.length > 15) return null;

    return `${countryCode}${digits}`;
}
