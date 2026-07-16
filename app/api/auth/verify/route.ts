import { NextResponse, type NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import { checkVerificationCode } from "@/lib/auth/twilio";
import { createSession } from "@/lib/auth/session";
import { normalizePhone, toE164 } from "@/lib/auth/phone";
import { normalizeEmail } from "@/lib/auth/email";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import type { Channel } from "@/types";
import { isTestingMode } from "@/lib/helpers/testingMode";

// ---------------------------------------------------------------------------
// POST /api/auth/verify — check the one-time code, then start a session.
//
// On approval:
//   1. Sets the `session` cookie via createSession().
//   2. Looks up the matching users-table row by phone or email (whichever
//      channel was used).
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
 * @param {NextRequest} request - The incoming request carrying `{ contact, channel, code }`.
 * @returns {Promise<NextResponse>} 200 with `{ ok, redirectTo }` on success, 400/401 on bad input or rejection.
 */
export async function POST(request: NextRequest) {
    // Parse defensively — a non-JSON body shouldn't 500 the route.
    let body: {
        contact?: unknown;
        channel?: unknown;
        code?: unknown;
        eventCode?: unknown;
    };
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

    // `contact` is the DB-canonical form used for session + lookup; `target`
    // is the form Twilio expects for the channel (E.164 for phone, same as
    // `contact` for email). Re-deriving from `body.contact` here means a
    // client tampering with the echoed value can't smuggle a differently
    // formatted string past us.
    const contact = raw
        ? channel === "email"
            ? normalizeEmail(raw)
            : normalizePhone(raw)
        : null;
    const target = raw ? (channel === "email" ? contact : toE164(raw)) : null;
    const code = typeof body.code === "string" ? body.code.trim() : "";
    // Event code from the login URL — persisted to the session so getEventCode()
    // can resolve it on later requests, once the `?event=` param is gone.
    const eventCode =
        typeof body.eventCode === "string" ? body.eventCode : undefined;

    if (!contact || !target || !code) {
        return NextResponse.json(
            {
                error: `${channel === "email" ? "Email" : "Phone"} and code are required.`,
            },
            { status: 400 },
        );
    }

    // Twilio enforces attempt limits, code expiry, and reuse prevention.
    let approved = false;
    try {
        approved = await checkVerificationCode(target, code);
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
    // phone or email can sign in. Tighten here (e.g. allow-list check against
    // the users table) when the product requires it.
    await createSession(contact, channel, eventCode);

    // Look up the user record so we can update last_login and steer admins
    // to the admin section. Doing this AFTER createSession means a missing
    // users row doesn't block login — the session is still set with `contact`,
    // and the user simply lands on "/" with no admin privileges.
    let redirectTo = "/";
    try {
        const [user] =
            channel === "email"
                ? await db
                      .update(users)
                      .set({ lastLogin: sql`now()` })
                      .where(eq(users.email, contact))
                      .returning()
                : await db
                      .update(users)
                      .set({ lastLogin: sql`now()` })
                      .where(eq(users.phone, contact))
                      .returning();
        if (user?.role === "admin") {
            // In testing mode admins exercise the frontend, so land them on "/" instead.
            redirectTo = isTestingMode() ? "/" : "/admin";
        }
    } catch (err) {
        // Don't let a DB hiccup block a freshly-verified login. Log and move on.
        console.error("Failed to update last_login / read role", err);
    }

    return NextResponse.json({ ok: true, redirectTo });
}
