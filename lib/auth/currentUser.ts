import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users, type User } from "@/lib/db/schema";
import { getSession } from "./session";
import { resolveIdentity } from "./identity";
import type { ResolvedIdentity } from "@/types";
import { loadAttendees } from "../attendees/loader";
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
        // mock identity so the frontend renders without logging in.
        if (process.env.NEXT_PUBLIC_DISABLE_LOGIN_AUTHENTICATION === "true") {
            return resolveMockIdentity();
        }
        const session = await getSession();
        if (!session) return null;

        const identity = await resolveIdentity(
            session.contact,
            session.channel,
        );

        // In testing mode, let an admin exercise the frontend by standing in as
        // the first mock attendee — this gives them a Salesforce id so meeting
        // requests can be saved. (Outside testing mode, admins are redirected
        // off the frontend to /admin.)
        if (identity?.role === "admin" && isTestingMode()) {
            return resolveMockIdentity();
        }
        return identity;
    },
);

/**
 * Resolves the identity for the mock/auth-disabled flow as the FIRST attendee in
 * the mock data. Everything is derived from that record so the identity stays
 * consistent with the mock file — in particular `salesforceId` is the first
 * attendee's real id (used as the requester when saving requests), not a
 * hardcoded value that drifts when the mock data changes.
 *
 * @returns {Promise<ResolvedIdentity>} The resolved mock identity.
 */
async function resolveMockIdentity(): Promise<ResolvedIdentity> {
    const attendees = await loadAttendees(true);
    const attendee = attendees[0];
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
