import { NextResponse, type NextRequest } from "next/server";
import { sendVerificationCode } from "@/lib/auth/twilio";
import { normalizePhone } from "@/lib/auth/phone";

// ---------------------------------------------------------------------------
// POST /api/auth/login — start the SMS one-time-code flow.
//
// Body: { phone: string }  (user-entered, any format we can normalize)
// Returns: { phone: string } — the normalized E.164 number the code was sent
// to, which the client echoes back in the verify request so we don't trust a
// re-typed value.
// ---------------------------------------------------------------------------

/**
 * Triggers Twilio Verify to send an SMS code to the supplied phone number.
 *
 * @param {NextRequest} request - The incoming request carrying `{ phone }` JSON.
 * @returns {Promise<NextResponse>} 200 with the normalized phone, or 400 on bad input.
 */
export async function POST(request: NextRequest) {
    // Parse defensively — a non-JSON body shouldn't 500 the route.
    let body: { phone?: unknown };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Coerce to string and validate format before paying for an SMS.
    const phone = typeof body.phone === "string" ? normalizePhone(body.phone) : null;
    if (!phone) {
        return NextResponse.json(
            { error: "A valid phone number is required." },
            { status: 400 },
        );
    }

    // Twilio handles code generation, delivery, expiry, and per-number rate
    // limiting — we just kick it off.
    try {
        await sendVerificationCode(phone);
    } catch (err) {
        console.error("Twilio sendVerificationCode failed", err);
        return NextResponse.json(
            { error: "Could not send verification code. Please try again." },
            { status: 502 },
        );
    }

    // Echo back the normalized number so the client uses the same value on verify.
    return NextResponse.json({ phone });
}
