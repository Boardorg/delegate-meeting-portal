import "server-only";
import { cache } from "react";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { eventSettings, type EventSettingsRow } from "@/lib/db/schema";

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
