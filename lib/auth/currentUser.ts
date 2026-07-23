import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users, type User } from "@/lib/db/schema";
import { getSession, SPOOF_SPONSOR_COOKIE } from "./session";
import { resolveIdentity } from "./identity";
import type { ResolvedIdentity } from "@/types";
import { loadAttendees } from "../attendees/loader";
import { getEventCode } from "@/lib/helpers/getEventCode";
import { isTestingMode } from "@/lib/helpers/testingMode";

// ---------------------------------------------------------------------------
// getCurrentUser — bridges the session cookie to the users table.
//
// The session JWT only carries `contact` + `channel` (the login key);
// everything else — id, role, username, email, last_login — lives in the DB
// and is looked up fresh on each render. Wrapped in React's `cache` so
// multiple server components in the same request share one query.
// ---------------------------------------------------------------------------

/**
 * Reads the session cookie and returns the matching DB user, or null if no
 * session exists or the contact doesn't map to a user row.
 *
 * Call from server components, server actions, and route handlers. Safe to
 * call repeatedly inside a single request — the result is memoized.
 *
 * @returns {Promise<User | null>} The matching user, or null.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
    const session = await getSession();
    if (!session) return null;

    const [user] =
        session.channel === "email"
            ? await db
                  .select()
                  .from(users)
                  .where(eq(users.email, session.contact))
                  .limit(1)
            : await db
                  .select()
                  .from(users)
                  .where(eq(users.phone, session.contact))
                  .limit(1);
    return user ?? null;
});

/**
 * Resolves the full identity (role + salesforceId) for the logged-in session,
 * checking the users table first and falling back to the live Salesforce
 * attendee/sponsor lists. Use this on the frontend where users may exist only
 * in Salesforce and have no users-table row; `getCurrentUser` covers the
 * admin path where a row always exists.
 *
 * Memoized per request like `getCurrentUser`.
 *
 * @returns {Promise<ResolvedIdentity | null>} The resolved identity, or null.
 */
export const getCurrentIdentity = cache(
    async (): Promise<ResolvedIdentity | null> => {
        // Auth bypass for dev/preview: skip the real session and hand back a
        // spoofed identity so the frontend renders without logging in.
        if (process.env.NEXT_PUBLIC_DISABLE_LOGIN_AUTHENTICATION === "true") {
            return resolveSpoofedIdentity();
        }
        const session = await getSession();
        if (!session) return null;

        const identity = await resolveIdentity(
            session.contact,
            session.channel,
        );

        // In testing mode, let an admin exercise the frontend by standing in as
        // a sponsor of the active event (chosen via the admin sponsor switcher).
        // This gives them a Salesforce id so meeting requests can be saved.
        // (Outside testing mode, admins are redirected off the frontend to /admin.)
        if (identity?.role === "admin" && isTestingMode()) {
            // Fall back to the real admin identity if there's no sponsor to spoof
            // (e.g. an event with none) so the frontend guard sends them to
            // /admin rather than bouncing to /login.
            return (await resolveSpoofedIdentity()) ?? identity;
        }
        return identity;
    },
);

/**
 * Resolves the identity used when an admin exercises the frontend (auth-disabled
 * dev, or testing-mode admin spoofing). It stands in as a sponsor of the active
 * event: the one selected in the admin sponsor switcher (`admin_spoof_sponsor`
 * cookie), or the first sponsor when none is chosen / the cookie is stale.
 * Deriving from a real attendee gives a valid `salesforceId` (used as the
 * requester when saving requests) and Cvent contact id (for pushing).
 *
 * The attendee source follows the same resolution the frontend uses — the
 * active event via getEventCode() and mock-vs-Salesforce via USE_MOCK — so the
 * spoofed identity always matches what the catalog shows.
 *
 * @returns {Promise<ResolvedIdentity | null>} The spoofed identity, or null when the event has no attendees.
 */
async function resolveSpoofedIdentity(): Promise<ResolvedIdentity | null> {
    const eventCode = await getEventCode();
    const attendees = await loadAttendees(false, eventCode);

    // Prefer sponsors (spoofing is for the sponsor-facing catalog); if the event
    // somehow has none, fall back to any attendee so the page still renders.
    const sponsors = attendees.filter((a) => a.role === "sponsor");
    const pool = sponsors.length > 0 ? sponsors : attendees;

    const selectedId = (await cookies()).get(SPOOF_SPONSOR_COOKIE)?.value;
    const attendee =
        (selectedId && pool.find((a) => a.salesforceId === selectedId)) ||
        pool[0];
    if (!attendee) return null;

    return {
        contact: attendee.phone || "+15555550101",
        role: attendee.role === "sponsor" ? "sponsor" : "user",
        channel: "sms",
        source: "salesforce",
        salesforceId: attendee.salesforceId,
        user: null,
        attendee,
    };
}
