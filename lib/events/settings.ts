import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { eventSettings, type EventSettingsRow } from "@/lib/db/schema";
import { ACTIVE_EVENT_COOKIE } from "@/lib/auth/session";

// ---------------------------------------------------------------------------
// Event settings accessors
//
// Read-side helpers over the event_settings table. This table is the registry
// of events (drives the global dropdown) and the source of per-event Cvent
// identifiers used by lib/cvent/client.ts. Reads are request-memoized via
// React's `cache` so multiple callers in one render share a query.
// ---------------------------------------------------------------------------

/**
 * Returns the settings row for one event code, or null if none exists.
 *
 * @param {string} code - The event code (e.g. "BMWS").
 * @returns {Promise<EventSettingsRow | null>} The row, or null.
 */
export const getEventSettings = cache(
    async (code: string): Promise<EventSettingsRow | null> => {
        const [row] = await db
            .select()
            .from(eventSettings)
            .where(eq(eventSettings.code, code))
            .limit(1);
        return row ?? null;
    },
);

/**
 * Returns all configured events, ordered by code — the source for the global
 * event dropdown.
 *
 * @returns {Promise<EventSettingsRow[]>} All event settings rows.
 */
export const listEvents = cache(async (): Promise<EventSettingsRow[]> => {
    return db.select().from(eventSettings).orderBy(asc(eventSettings.code));
});

/**
 * Resolves the admin's active event code — the single source of truth used by
 * the admin shell and, in testing mode, by getEventCode. Returns the
 * `admin_event` cookie when it points at a known event; otherwise falls back to
 * the first event in the list (or null when there are none). So if no event has
 * been explicitly selected, the first one is used by default.
 *
 * @returns {Promise<string | null>} The active event code, or null.
 */
export const resolveActiveEventCode = cache(
    async (): Promise<string | null> => {
        const [events, cookieStore] = await Promise.all([
            listEvents(),
            cookies(),
        ]);
        const cookieCode = cookieStore.get(ACTIVE_EVENT_COOKIE)?.value;
        if (cookieCode && events.some((e) => e.code === cookieCode)) {
            return cookieCode;
        }
        return events[0]?.code ?? null;
    },
);
