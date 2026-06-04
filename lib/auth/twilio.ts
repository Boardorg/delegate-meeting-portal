import "server-only";
import twilio, { type Twilio } from "twilio";

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
 * Asks Twilio Verify to send an SMS one-time code to the given phone number.
 * Twilio owns code generation, expiration, and per-number rate limiting — we
 * never see or store the code itself.
 *
 * @param {string} phone - Target phone number in E.164 format (e.g. "+15555550123").
 * @returns {Promise<void>}
 */
export async function sendVerificationCode(phone: string): Promise<void> {
    const { verifyServiceSid } = readEnv();
    await getClient()
        .verify.v2.services(verifyServiceSid)
        .verifications.create({ to: phone, channel: "sms" });
}

/**
 * Submits a user-entered code to Twilio Verify for the given phone number and
 * returns whether it was accepted. Twilio enforces attempt limits and code
 * expiry on its end; a "false" result here covers all rejection reasons.
 *
 * @param {string} phone - The phone number the code was sent to, in E.164.
 * @param {string} code - The code entered by the user.
 * @returns {Promise<boolean>} True if Twilio reports status "approved".
 */
export async function checkVerificationCode(
    phone: string,
    code: string,
): Promise<boolean> {
    const { verifyServiceSid } = readEnv();
    try {
        const check = await getClient()
            .verify.v2.services(verifyServiceSid)
            .verificationChecks.create({ to: phone, code });
        return check.status === "approved";
    } catch {
        // Twilio raises on expired/exceeded-attempts verifications; treat as
        // a plain "not approved" so the route layer can give the same generic
        // error message regardless of cause.
        return false;
    }
}
