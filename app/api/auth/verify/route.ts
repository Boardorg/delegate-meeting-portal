import { NextResponse, type NextRequest } from "next/server";
import { checkVerificationCode } from "@/lib/auth/twilio";
import { createSession } from "@/lib/auth/session";
import { normalizePhone } from "@/lib/auth/phone";

// ---------------------------------------------------------------------------
// POST /api/auth/verify — check the SMS code and start a session.
//
// Body: { phone: string; code: string }
// On success, sets the `session` cookie via createSession() and returns 200.
// ---------------------------------------------------------------------------

/**
 * Verifies the user-entered code with Twilio Verify and, on approval, sets
 * the signed session cookie.
 *
 * @param {NextRequest} request - The incoming request carrying `{ phone, code }`.
 * @returns {Promise<NextResponse>} 200 on success, 400/401 on bad input or rejection.
 */
export async function POST(request: NextRequest) {
    // Parse defensively — a non-JSON body shouldn't 500 the route.
    let body: { phone?: unknown; code?: unknown };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Re-normalize the phone here so a client tampering with the echoed value
    // can't smuggle a differently-formatted string past us.
    const phone = typeof body.phone === "string" ? normalizePhone(body.phone) : null;
    const code = typeof body.code === "string" ? body.code.trim() : "";

    if (!phone || !code) {
        return NextResponse.json(
            { error: "Phone and code are required." },
            { status: 400 },
        );
    }

    // Twilio enforces attempt limits, code expiry, and reuse prevention.
    let approved = false;
    try {
        approved = await checkVerificationCode(phone, code);
    } catch (err) {
        console.error("Twilio checkVerificationCode failed", err);
        return NextResponse.json(
            { error: "Could not verify code. Please try again." },
            { status: 502 },
        );
    }

    if (!approved) {
        return NextResponse.json(
            { error: "Invalid or expired code." },
            { status: 401 },
        );
    }

    // Approval is the only authorization gate today — anyone with a working
    // phone can sign in. Tighten here (e.g. allow-list check against Salesforce
    // Contact phone numbers) when the product requires it.
    await createSession(phone);
    return NextResponse.json({ ok: true });
}
