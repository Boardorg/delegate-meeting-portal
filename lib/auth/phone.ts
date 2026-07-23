// ---------------------------------------------------------------------------
// Phone-number helpers
//
// Two distinct operations on a user-entered phone string:
//
//   normalizePhone(input)
//     Cleans the formatting (spaces, dashes, parens) and strips a redundant
//     US/Canada country code down to the bare 10-digit local number. "+1..."
//     and "1..." forms collapse to the same value as the plain 10-digit
//     form. This is the form used for DB storage and lookup, so any of the
//     three input styles match the same stored user.
//
//   toE164(input)
//     Returns the E.164 form Twilio Verify requires. Same cleaning as
//     normalizePhone, plus a leading "+1" if the input had no "+" — the
//     fallback country code is US.
//
// Both return null when the input doesn't look like a phone number, so
// callers can fail loudly at the boundary instead of pushing junk
// downstream.
// ---------------------------------------------------------------------------

// Default country code applied by `toE164` when the user didn't supply one.
// US-only for now; revisit when the product needs international logins.
const DEFAULT_COUNTRY_CODE = "+1";

/**
 * Strips formatting from a phone string. Internal helper for both public
 * functions — returns `{ hasPlus, digits }` or null if the digit count
 * is implausibly short or long.
 *
 * @param {string} input - Raw user input.
 * @returns {{ hasPlus: boolean; digits: string } | null} Parsed phone, or null.
 */
function parsePhone(input: string): { hasPlus: boolean; digits: string } | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    let hasPlus = trimmed.startsWith("+");
    let digits = trimmed.replace(/\D/g, "");

    // E.164 allows 8–15 digits; be lenient on the low end but reject obvious junk.
    if (digits.length < 7 || digits.length > 15) return null;

    // Collapse US/Canada country code to the bare 10-digit local number.
    // This makes "+15555550123" and "15555550123" parse the same as 
    // "5555550123" the DB stores.
    if (digits.length === 11 && digits.startsWith("1")) {
        digits = digits.slice(1);
        hasPlus = false;
    }

    return { hasPlus, digits };
}

/**
 * Canonical form for DB storage and lookup. Strips formatting but does NOT
 * add a country code — what the admin entered is what gets stored, and the
 * login flow normalizes the same way for matching.
 *
 * Behavior:
 *  - "+1 (555) 555-0123" → "5555550123" (redundant US country code stripped)
 *  - "15555550123"       → "5555550123" (same, without the "+")
 *  - "5555550123"        → "5555550123" (no auto-prepending of country code)
 *  - "abc"               → null
 *
 * @param {string} input - Raw user input.
 * @returns {string | null} The cleaned phone, or null on bad input.
 */
export function normalizePhone(input: string): string | null {
    const p = parsePhone(input);
    if (!p) return null;
    return p.hasPlus ? `+${p.digits}` : p.digits;
}

/**
 * E.164 form for Twilio Verify. Same cleaning as `normalizePhone`, plus a
 * default "+1" prefix when the user didn't type a "+".
 *
 * Behavior:
 *  - "+44 7700 900123" → "+447700900123"
 *  - "5555550123"      → "+15555550123"
 *  - "15555550123"     → "+15555550123"
 *  - "abc"             → null
 *
 * @param {string} input - Raw user input.
 * @returns {string | null} The E.164 phone, or null on bad input.
 */
export function toE164(input: string): string | null {
    const p = parsePhone(input);
    if (!p) return null;
    return p.hasPlus ? `+${p.digits}` : `${DEFAULT_COUNTRY_CODE}${p.digits}`;
}
