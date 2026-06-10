import { NextResponse, type NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import { checkVerificationCode } from "@/lib/auth/twilio";
import { createSession } from "@/lib/auth/session";
import { normalizePhone, toE164 } from "@/lib/auth/phone";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// POST /api/auth/verify — check the SMS code, then start a session.
//
// On approval:
//   1. Sets the `session` cookie via createSession().
//   2. Looks up the matching users-table row by phone.
//      - Bumps `last_login` to now() so the admin table reflects activity.
//      - Picks a default landing page based on role: admins → "/admin",
//        everyone else → "/".
//   3. Returns `{ ok: true, redirectTo }`. The login client may override
//      this with a more-specific `next` query param when one is present.
// ---------------------------------------------------------------------------

/**
 * Verifies the user-entered code with Twilio Verify and, on approval, sets
 * the signed session cookie.
 *
 * @param {NextRequest} request - The incoming request carrying `{ phone, code }`.
 * @returns {Promise<NextResponse>} 200 with `{ ok, redirectTo }` on success, 400/401 on bad input or rejection.
 */
export async function POST(request: NextRequest) {
    // Parse defensively — a non-JSON body shouldn't 500 the route.
    let body: { phone?: unknown; code?: unknown };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // `phone` is the DB-canonical form used for session + lookup; `e164` is
    // the E.164 form Twilio expects (same number, with "+1" filled in when
    // the user didn't type a "+"). Re-deriving from `body.phone` here means
    // a client tampering with the echoed value can't smuggle a differently
    // formatted string past us.
    const phone = typeof body.phone === "string" ? normalizePhone(body.phone) : null;
    const e164 = typeof body.phone === "string" ? toE164(body.phone) : null;
    const code = typeof body.code === "string" ? body.code.trim() : "";

    if (!phone || !e164 || !code) {
        return NextResponse.json(
            { error: "Phone and code are required." },
            { status: 400 },
        );
    }

    // Twilio enforces attempt limits, code expiry, and reuse prevention.
    let approved = false;
    try {
        approved = await checkVerificationCode(e164, code);
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
    // phone can sign in. Tighten here (e.g. allow-list check against the
    // users table) when the product requires it.
    await createSession(phone);

    // Look up the user record so we can update last_login and steer admins
    // to the admin section. Doing this AFTER createSession means a missing
    // users row doesn't block login — the session is still set with `phone`,
    // and the user simply lands on "/" with no admin privileges.
    let redirectTo = "/";
    try {
        const [user] = await db
            .update(users)
            .set({ lastLogin: sql`now()` })
            .where(eq(users.phone, phone))
            .returning();
        if (user?.role === "admin") {
            redirectTo = "/admin";
        }
    } catch (err) {
        // Don't let a DB hiccup block a freshly-verified login. Log and move on.
        console.error("Failed to update last_login / read role", err);
    }

    return NextResponse.json({ ok: true, redirectTo });
}
