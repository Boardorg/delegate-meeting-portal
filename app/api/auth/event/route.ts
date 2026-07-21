import { NextResponse, type NextRequest } from "next/server";
import { getSession, createSession } from "@/lib/auth/session";
import { resolveIdentity } from "@/lib/auth/identity";
import { getEventSettings } from "@/lib/events/settings";

// ---------------------------------------------------------------------------
// POST /api/auth/event — attach an event code to an already-verified session.
//
// The user is logged in (OTP already verified) but their session has no
// `eventCode` because they never followed an `?event=` link. Before
// persisting the typed code we confirm the event itself exists, then
// re-verify against Salesforce that this contact actually belongs to it —
// local `users` rows (admins, manually-managed accounts) aren't event-scoped,
// so the event-existence check is what catches a made-up code for them.
// ---------------------------------------------------------------------------

/**
 * Validates a manually-entered event code against the current session's
 * contact and, on success, re-signs the session cookie with it attached.
 *
 * @param {NextRequest} request - The incoming request carrying `{ eventCode }` JSON.
 * @returns {Promise<NextResponse>} 200 on success, 401 with no session, 400 on a missing
 *   code, 404 if the event doesn't exist, 403 if the contact isn't part of it.
 */
export async function POST(request: NextRequest) {
    const session = await getSession();
    if (!session) {
        return NextResponse.json(
            { error: "Session expired. Please log in again." },
            { status: 401 },
        );
    }

    let body: { eventCode?: unknown };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json(
            { error: "Invalid JSON body" },
            { status: 400 },
        );
    }

    const eventCode =
        typeof body.eventCode === "string" ? body.eventCode.trim() : "";
    if (!eventCode) {
        return NextResponse.json(
            { error: "Event code is required." },
            { status: 400 },
        );
    }

    const eventSettings = await getEventSettings(eventCode);
    if (!eventSettings) {
        return NextResponse.json(
            { error: "We couldn't find that event code." },
            { status: 404 },
        );
    }

    // Only accept a code that this contact actually resolves under — same
    // check the login flow itself relies on.
    const identity = await resolveIdentity(
        session.contact,
        session.channel,
        eventCode,
    );
    if (!identity) {
        return NextResponse.json(
            { error: "We couldn't find you under that event code." },
            { status: 403 },
        );
    }

    await createSession(session.contact, session.channel, eventCode);
    return NextResponse.json({ ok: true });
}
