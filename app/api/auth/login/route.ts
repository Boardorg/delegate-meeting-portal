import { NextResponse, type NextRequest } from "next/server";
import { sendVerificationCode } from "@/lib/auth/twilio";
import { normalizePhone, toE164 } from "@/lib/auth/phone";
import { resolveIdentity } from "@/lib/auth/identity";

// ---------------------------------------------------------------------------
// POST /api/auth/login — start the SMS one-time-code flow.
//
// Body: { phone: string }  (user-entered, any format we can normalize)
// Returns: { phone: string } — the cleaned (NOT E.164) phone the user
// entered, which the client echoes back on verify. This is the form stored
// in the users table; the route converts to E.164 internally just for the
// Twilio call.
// ---------------------------------------------------------------------------

/**
 * Triggers Twilio Verify to send an SMS code to the supplied phone number.
 *
 * @param {NextRequest} request - The incoming request carrying `{ phone }` JSON.
 * @returns {Promise<NextResponse>} 200 with the cleaned phone, or 400 on bad input.
 */
export async function POST(request: NextRequest) {
    // Parse defensively — a non-JSON body shouldn't 500 the route.
    let body: { phone?: unknown; eventCode?: unknown };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json(
            { error: "Invalid JSON body" },
            { status: 400 },
        );
    }

    // `normalizePhone` is the DB-canonical form (cleaned, no auto country
    // code) — what we echo back to the client and what verify will use to
    // look the user up. `toE164` is the same number forced into E.164 so
    // Twilio Verify accepts it. We validate both here so a bad input fails
    // before paying for an SMS.
    const phone =
        typeof body.phone === "string" ? normalizePhone(body.phone) : null;
    const e164 = typeof body.phone === "string" ? toE164(body.phone) : null;
    if (!phone || !e164) {
        return NextResponse.json(
            { error: "A valid phone number is required." },
            { status: 400 },
        );
    }

    // Event code from the login URL (forwarded in the body). There's no session
    // yet, so it's passed explicitly to the attendee match below.
    const eventCode =
        typeof body.eventCode === "string" ? body.eventCode : undefined;

    // Only send a code to numbers we recognize — either a local users-table
    // row (admins / managed users) or a live Salesforce attendee/sponsor for
    // the current event. Unknown numbers are rejected here so we never pay for
    // an SMS to someone who couldn't log in anyway. (This intentionally reveals
    // whether a number is known — an accepted tradeoff for this portal.)
    let identity;
    try {
        identity = await resolveIdentity(phone, eventCode);
    } catch (err) {
        console.error("resolveIdentity failed", err);
        return NextResponse.json(
            { error: "Could not verify access. Please try again." },
            { status: 502 },
        );
    }
    if (!identity) {
        return NextResponse.json(
            { error: "We couldn't find that phone number for this event." },
            { status: 403 },
        );
    }

    // Twilio handles code generation, delivery, expiry, and per-number rate
    // limiting — we just kick it off with the E.164 form.
    try {
        await sendVerificationCode(e164);
    } catch (err) {
        console.error("Twilio sendVerificationCode failed", err);
        return NextResponse.json(
            { error: "Could not send verification code. Please try again." },
            { status: 502 },
        );
    }

    // Echo back the DB-canonical phone so the client sends the same value on verify.
    return NextResponse.json({ phone });
}
