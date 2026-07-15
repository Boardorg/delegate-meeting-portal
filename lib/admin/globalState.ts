import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth/currentUser";
import { listEvents } from "@/lib/events/settings";
import type { EventSettingsRow, User } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Admin global state
//
// The single home for admin-wide global state that server components read.
// Today it merges the current user (previously the only piece of "global"
// state, via getCurrentUser) with the active event selection. Add future
// admin-wide globals to AdminState + getAdminState() rather than scattering
// new accessors around the app.
//
// The active event is stored in a cookie so both the sidebar switcher and
// every page resolve the same selection. getAdminState is request-memoized via
// React's `cache`, so repeated reads in one render share the work.
// ---------------------------------------------------------------------------

/** Cookie holding the admin's selected event code. */
export const ACTIVE_EVENT_COOKIE = "admin_event";

/** Everything the admin shell needs about "who + which event" in one shape. */
export type AdminState = {
    /** The logged-in admin user (null when auth is disabled / no row). */
    user: User | null;
    /** All configured events — the registry that drives the event dropdown. */
    events: EventSettingsRow[];
    /** The active event's code, or null when there are no events. */
    activeEventCode: string | null;
};

/**
 * Assembles the admin global state for the current request: the current user,
 * the list of configured events, and the resolved active event code.
 *
 * The active code comes from the `admin_event` cookie, validated against the
 * known events; if the cookie is missing or stale it falls back to the first
 * event (or null when none exist).
 *
 * @returns {Promise<AdminState>} The merged global state.
 */
export const getAdminState = cache(async (): Promise<AdminState> => {
    const [user, events, cookieStore] = await Promise.all([
        getCurrentUser(),
        listEvents(),
        cookies(),
    ]);

    const cookieCode = cookieStore.get(ACTIVE_EVENT_COOKIE)?.value;
    const activeEventCode =
        (cookieCode && events.some((e) => e.code === cookieCode)
            ? cookieCode
            : events[0]?.code) ?? null;

    return { user, events, activeEventCode };
});

/**
 * Convenience wrapper returning just the resolved active event code.
 *
 * @returns {Promise<string | null>} The active event code, or null.
 */
export async function getActiveEventCode(): Promise<string | null> {
    return (await getAdminState()).activeEventCode;
}
