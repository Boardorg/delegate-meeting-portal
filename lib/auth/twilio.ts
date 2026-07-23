import "server-only";
import twilio, { type Twilio } from "twilio";
import type { Channel } from "@/types";

// ---------------------------------------------------------------------------
// Module configuration and constants
// ---------------------------------------------------------------------------

// Lazily-built singleton client. Built once per Node process so we don't pay
// the construction cost on every request, but deferred until first use so
// importing this module doesn't throw when env vars are missing (e.g. during
// type checks).
let client: Twilio | null = null;

/**
 * Reads and validates the three required Twilio env vars in one place so a
 * missing value produces a single, clear error instead of a downstream API
 * failure.
 *
 * @returns {{ accountSid: string; authToken: string; verifyServiceSid: string }} The validated credentials.
 */
function readEnv() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

    if (!accountSid || !authToken || !verifyServiceSid) {
        throw new Error(
            "Missing Twilio env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID",
        );
    }
    return { accountSid, authToken, verifyServiceSid };
}

/**
 * Returns the cached Twilio client, constructing it on first use.
 *
 * @returns {Twilio} An authenticated Twilio REST client.
 */
function getClient(): Twilio {
    if (client) return client;
    const { accountSid, authToken } = readEnv();
    client = twilio(accountSid, authToken);
    return client;
}

// ---------------------------------------------------------------------------
// Verify API wrappers
// ---------------------------------------------------------------------------

/**
 * Asks Twilio Verify to send a one-time code to the given phone number or
 * email address. Twilio owns code generation, expiration, and per-recipient
 * rate limiting — we never see or store the code itself.
 *
 * @param {string} to - Target phone number (E.164, e.g. "+15555550123") or email address.
 * @param {Channel} channel - "sms" for a phone number, "email" for an email address.
 * @returns {Promise<void>}
 */
export async function sendVerificationCode(
    to: string,
    channel: Channel,
): Promise<void> {
    const { verifyServiceSid } = readEnv();
    await getClient()
        .verify.v2.services(verifyServiceSid)
        .verifications.create({ to, channel });
}

/**
 * Submits a user-entered code to Twilio Verify for the given phone number or
 * email address and returns whether it was accepted. Twilio enforces attempt
 * limits and code expiry on its end; a "false" result here covers all
 * rejection reasons. Twilio infers the channel from `to`, so no channel
 * argument is needed here.
 *
 * @param {string} to - The phone number (E.164) or email address the code was sent to.
 * @param {string} code - The code entered by the user.
 * @returns {Promise<boolean>} True if Twilio reports status "approved".
 */
export async function checkVerificationCode(
    to: string,
    code: string,
): Promise<boolean> {
    const { verifyServiceSid } = readEnv();
    try {
        const check = await getClient()
            .verify.v2.services(verifyServiceSid)
            .verificationChecks.create({ to, code });
        return check.status === "approved";
    } catch {
        // Twilio raises on expired/exceeded-attempts verifications; treat as
        // a plain "not approved" so the route layer can give the same generic
        // error message regardless of cause.
        return false;
    }
}
