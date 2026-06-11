import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users, type User } from "@/lib/db/schema";
import { decryptSession, SESSION_COOKIE } from "./session";
import { resolveIdentity, type ResolvedIdentity } from "./identity";
import { loadAttendees } from "../attendees/loader";

// ---------------------------------------------------------------------------
// getCurrentUser — bridges the session cookie to the users table.
//
// The session JWT only carries `phone` (the SMS login key); everything else
// — id, role, username, email, last_login — lives in the DB and is looked up
// fresh on each render. Wrapped in React's `cache` so multiple server
// components in the same request share one query.
// ---------------------------------------------------------------------------

/**
 * Reads the session cookie and returns the matching DB user, or null if no
 * session exists or the phone doesn't map to a user row.
 *
 * Call from server components, server actions, and route handlers. Safe to
 * call repeatedly inside a single request — the result is memoized.
 *
 * @returns {Promise<User | null>} The matching user, or null.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    const session = await decryptSession(token);
    if (!session) return null;

    const [user] = await db
        .select()
        .from(users)
        .where(eq(users.phone, session.phone))
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
        //
        if (process.env.NEXT_PUBLIC_DISABLE_LOGIN_AUTHENTICATION !== "true") {
            return resolveMockIdentity();
        }
        const jar = await cookies();
        const token = jar.get(SESSION_COOKIE)?.value;
        const session = await decryptSession(token);
        if (!session) return null;
        return resolveIdentity(session.phone);
    },
);

/**
 * Resolves the identity for the mock data.
 *
 * @returns {Promise<ResolvedIdentity>} The resolved mock identity.
 */
async function resolveMockIdentity(): Promise<ResolvedIdentity> {
    const attendees = await loadAttendees(true);
    return {
        phone: "+15555550101",
        role: "sponsor",
        source: "salesforce",
        salesforceId: "a00PZ00000TMLocYAH",
        user: null,
        attendee: attendees[0],
    };
}
