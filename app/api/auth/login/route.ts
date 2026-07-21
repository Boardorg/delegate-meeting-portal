import { NextResponse, type NextRequest } from "next/server";
import { sendVerificationCode } from "@/lib/auth/twilio";
import { normalizePhone, toE164 } from "@/lib/auth/phone";
import { normalizeEmail } from "@/lib/auth/email";
import { resolveIdentity } from "@/lib/auth/identity";
import type { Channel } from "@/types";

// ---------------------------------------------------------------------------
// POST /api/auth/login — start the one-time-code flow, over SMS or email.
//
// Body: { contact: string, channel: "sms" | "email" }  (user-entered, any
// format we can normalize)
// Returns: { contact: string, channel: "sms" | "email" } — the cleaned
// (NOT E.164 for phone) contact the user entered, which the client echoes
// back on verify. This is the form stored in the users table; the route
// converts phone to E.164 internally just for the Twilio call.
// ---------------------------------------------------------------------------

/**
 * Triggers Twilio Verify to send a one-time code to the supplied phone
 * number or email address.
 *
 * @param {NextRequest} request - The incoming request carrying `{ contact, channel }` JSON.
 * @returns {Promise<NextResponse>} 200 with the cleaned contact, or 400 on bad input.
 */
export async function POST(request: NextRequest) {
    // Parse defensively — a non-JSON body shouldn't 500 the route.
    let body: { contact?: unknown; channel?: unknown; eventCode?: unknown };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json(
            { error: "Invalid JSON body" },
            { status: 400 },
        );
    }

    const channel: Channel = body.channel === "email" ? "email" : "sms";
    const raw = typeof body.contact === "string" ? body.contact : null;

    // `contact` is the DB-canonical form (cleaned, no auto country code for
    // phone; trimmed + lowercased for email) — what we echo back to the
    // client and what verify will use to look the user up. `target` is the
    // form Twilio Verify wants for the given channel (E.164 for phone, same
    // as `contact` for email). We validate both here so a bad input fails
    // before paying for a send.
    const contact = raw
        ? channel === "email"
            ? normalizeEmail(raw)
            : normalizePhone(raw)
        : null;
    const target = raw
        ? channel === "email"
            ? contact
            : toE164(raw)
        : null;
    if (!contact || !target) {
        return NextResponse.json(
            {
                error:
                    channel === "email"
                        ? "A valid email address is required."
                        : "A valid phone number is required.",
            },
            { status: 400 },
        );
    }

    // Event code from the login URL (forwarded in the body). There's no session
    // yet, so it's passed explicitly to the attendee match below.
    const eventCode =
        typeof body.eventCode === "string" ? body.eventCode : undefined;

    // Only send a code to contacts we recognize — either a local users-table
    // row (admins / managed users) or a live Salesforce attendee/sponsor for
    // the current event. Unknown contacts are rejected here so we never pay
    // for a send to someone who couldn't log in anyway. (This intentionally
    // reveals whether a contact is known — an accepted tradeoff for this portal.)
    let identity;
    try {
        identity = await resolveIdentity(contact, channel, eventCode);
    } catch (err) {
        console.error("resolveIdentity failed", err);
        return NextResponse.json(
            { error: "Could not verify access. Please try again." },
            { status: 502 },
        );
    }
    if (!identity) {
        return NextResponse.json(
            {
                error: `We couldn't find that ${channel === "email" ? "email address" : "phone number"} for this event.`,
            },
            { status: 403 },
        );
    }

    // Twilio handles code generation, delivery, expiry, and per-recipient
    // rate limiting — we just kick it off with the channel-appropriate form.
    try {
        await sendVerificationCode(target, channel);
    } catch (err) {
        console.error("Twilio sendVerificationCode failed", err);
        return NextResponse.json(
            { error: "Could not send verification code. Please try again." },
            { status: 502 },
        );
    }

    // Echo back the DB-canonical contact so the client sends the same value on verify.
    return NextResponse.json({ contact, channel });
}
