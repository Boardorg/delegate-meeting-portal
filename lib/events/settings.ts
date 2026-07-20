import "server-only";
import { cache } from "react";
import { asc, eq, sql } from "drizzle-orm";
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

/**
 * Reserves a block of `count` meeting ids for an event, formatted as
 * "mtg-XXX". Backed by event_settings.next_meeting_seq, a counter that only
 * ever increases. Safe to call from multiple requests at once, since the
 * increase happens in a single UPDATE. Never memoized, since this mutates.
 *
 * Ids are never reused, even after a scheduled_meetings row is deleted.
 * Cvent keeps an appointment's code reserved even after it's cancelled, so
 * reusing an old id would collide with that appointment.
 *
 * @param {string} eventCode - The event to reserve ids for.
 * @param {number} count - How many ids to reserve.
 * @returns {Promise<string[]>} The reserved ids, in order (e.g. ["mtg-014", "mtg-015"]).
 * @throws {Error} When the event has no settings row.
 */
export async function reserveMeetingIds(
    eventCode: string,
    count: number,
): Promise<string[]> {
    if (count <= 0) return [];

    const [row] = await db
        .update(eventSettings)
        .set({ nextMeetingSeq: sql`${eventSettings.nextMeetingSeq} + ${count}` })
        .where(eq(eventSettings.code, eventCode))
        .returning({ nextMeetingSeq: eventSettings.nextMeetingSeq });
    if (!row) {
        throw new Error(
            `Cannot reserve meeting ids: no event settings row for "${eventCode}".`,
        );
    }

    const start = row.nextMeetingSeq - count;
    return Array.from(
        { length: count },
        (_, i) => `mtg-${String(start + i).padStart(3, "0")}`,
    );
}
