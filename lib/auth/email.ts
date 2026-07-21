// ---------------------------------------------------------------------------
// Email helper
//
// normalizeEmail(input)
//   Trims and lowercases a user-entered email address, then checks it looks
//   plausible (something@something.something, no whitespace). This is the
//   form used for DB storage, lookup, and the value passed to Twilio
//   Verify's email channel — email addresses are treated as
//   case-insensitive for login purposes.
//
// Returns null when the input doesn't look like an email, so callers can
// fail loudly at the boundary instead of pushing junk downstream.
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Canonical form for DB storage, lookup, and Twilio Verify's email channel.
 *
 * Behavior:
 *  - " Jane@Example.com " → "jane@example.com"
 *  - "not-an-email"       → null
 *
 * @param {string} input - Raw user input.
 * @returns {string | null} The cleaned email, or null on bad input.
 */
export function normalizeEmail(input: string): string | null {
    const trimmed = input.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(trimmed)) return null;
    return trimmed;
}
