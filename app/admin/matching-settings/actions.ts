"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { eventSettings } from "@/lib/db/schema";
import { describeDbError } from "@/lib/db/errors";
import { parseMatchingSettings, type MatchingSettings } from "@/lib/matching/settings";

// ---------------------------------------------------------------------------
// Server actions for /admin/matching-settings.
// ---------------------------------------------------------------------------

/** The result of saving matching settings. */
export type SaveMatchingResult = { ok: true; settings: MatchingSettings } | { ok: false; error: string };

/**
 * Saves an event's matching settings after checking them.
 * Bad input is refused with a message and nothing is saved.
 *
 * @param {string} eventCode - The event.
 * @param {unknown} input - The submitted settings.
 * @returns {Promise<SaveMatchingResult>} The saved settings, or why nothing was saved.
 */
export async function saveMatchingSettings(eventCode: string, input: unknown): Promise<SaveMatchingResult> {
    const parsed = parseMatchingSettings(input);
    if (!parsed.ok) return parsed;
    try {
        const updated = await db
            .update(eventSettings)
            .set({ matchingSettings: parsed.settings, updatedAt: new Date() })
            .where(eq(eventSettings.code, eventCode))
            .returning({ code: eventSettings.code });
        if (updated.length === 0) return { ok: false, error: "Error: event not found" };
    } catch (err) {
        return {
            ok: false,
            error: describeDbError(err, { table: "event_settings", fallback: "Error: could not save matching settings" }),
        };
    }
    revalidatePath("/admin", "layout");
    return { ok: true, settings: parsed.settings };
}
