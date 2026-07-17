// Intentionally not `server-only`: this is a pure env-var read used by server
// code, but keeping it guard-free lets it be imported in unit tests without a
// `server-only` shim. TESTING_MODE isn't a NEXT_PUBLIC var, so on the client it
// reads as undefined and this returns false — a safe default.

/**
 * Testing mode relaxes production safeguards for non-prod / dry-run events.
 * Enabled via the `TESTING_MODE` env var. When on:
 *   - Cvent attendee emails are treated as obfuscated (`xx<email>xx`) and the
 *     wrapper is stripped before the Salesforce↔Cvent email cross-check.
 *   - Admins may use the frontend portal (normally they're bounced to /admin).
 *   - When an admin needs a requester identity on the frontend, the first mock
 *     attendee stands in, giving them a Salesforce id so requests can be saved.
 *
 * @returns {boolean} True when TESTING_MODE is enabled.
 */
export function isTestingMode(): boolean {
    return process.env.TESTING_MODE === "true";
}
