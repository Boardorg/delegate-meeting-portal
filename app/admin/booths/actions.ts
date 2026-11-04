"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { eventSettings } from "@/lib/db/schema";
import { describeDbError } from "@/lib/db/errors";
import { loadEventScheduleData } from "@/lib/cvent/mapper";
import { validateBoothMapping } from "@/lib/scheduling/booths";
import type { Location } from "@/types";

// ---------------------------------------------------------------------------
// Server actions for /admin/booths, the Sponsor booths page.
//
// Salesforce decides which company has which booth number.
// The only thing saved here is which Cvent location a booth number means.
// Errors come back as a result so the row can show them, instead of being thrown.
// ---------------------------------------------------------------------------

/** The result of saving or removing one booth mapping. */
export type BoothMappingResult =
    | { ok: true }
    | { ok: false; error: string };

// event_settings errors map through the shared describer.
const BOOTH_DB_ERROR = {
    table: "event_settings",
    fallback: "Error: could not save the booth mapping",
};

/**
 * Saves or removes the manual Cvent location for one booth number.
 * A location id must be one of the event's Cvent locations, or nothing is saved.
 * A null location id removes the mapping, so the booth goes back to the automatic match.
 * The booth number is stored trimmed.
 *
 * The change is made in one SQL update on the jsonb column.
 * So two admins mapping different booths at once don't overwrite each other.
 *
 * @param {{ eventCode: string; boothNo: string; locationId: string | null }} params - The booth number and the location to map it to.
 * @returns {Promise<BoothMappingResult>} Success, or a message saying why nothing was saved.
 */
export async function saveBoothMapping(params: {
    eventCode: string;
    boothNo: string;
    locationId: string | null;
}): Promise<BoothMappingResult> {
    // Check the location against the event's Cvent locations before touching the row.
    // Removing a mapping needs no check.
    let locations: Location[] = [];
    if (params.locationId !== null) {
        const scheduleData = await loadEventScheduleData(params.eventCode);
        locations = scheduleData.locations;
        if (locations.length === 0) {
            return {
                ok: false,
                error: "Error: Cvent couldn't be reached to check the location, so nothing was saved. Try again in a few minutes.",
            };
        }
    }
    const valid = validateBoothMapping(params.boothNo, params.locationId, locations);
    if (!valid.ok) return valid;
    const boothNo = valid.boothNo;

    // Set or remove one key. An empty mapping is stored as SQL NULL.
    const current = sql`coalesce(${eventSettings.boothLocations}, '{}'::jsonb)`;
    const next =
        params.locationId === null
            ? sql`${current} - ${boothNo}::text`
            : sql`${current} || jsonb_build_object(${boothNo}::text, ${params.locationId}::text)`;

    try {
        const updated = await db
            .update(eventSettings)
            .set({
                boothLocations: sql`nullif(${next}, '{}'::jsonb)`,
                updatedAt: new Date(),
            })
            .where(eq(eventSettings.code, params.eventCode))
            .returning({ code: eventSettings.code });
        if (updated.length === 0) {
            return { ok: false, error: "Error: event not found" };
        }
    } catch (err) {
        return { ok: false, error: describeDbError(err, BOOTH_DB_ERROR) };
    }

    revalidatePath("/admin/booths");
    revalidatePath("/admin/meetings", "layout");
    return { ok: true };
}
