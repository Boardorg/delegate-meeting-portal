"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { eventSettings, type EventSettingsRow } from "@/lib/db/schema";
import { describeDbError } from "@/lib/db/errors";
import { setActiveEvent } from "@/app/admin/actions";

// ---------------------------------------------------------------------------
// Server actions for /admin/event-settings.
//
// CRUD over the event_settings table (the per-event Cvent config + event
// registry). Mirrors the users/actions.ts shape: a discriminated ActionResult
// so the form can render errors inline, and revalidatePath("/admin", "layout")
// so the global event switcher picks up new/removed events.
// ---------------------------------------------------------------------------

/** Success carries the affected row; failure carries a user-visible message. */
export type ActionResult =
    | { ok: true; event: EventSettingsRow }
    | { ok: false; error: string };

// event_settings errors map through the shared describer; the table name lets
// it turn an `event_settings_code_unique` violation into "duplicate code".
const EVENT_DB_ERROR = {
    table: "event_settings",
    fallback: "Error: could not save event",
};

/** Trims a string field to null when empty, so blanks store as SQL NULL. */
function trimToNull(v: unknown): string | null {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t === "" ? null : t;
}

/** The settings fields a create/update accepts (code excluded from updates). */
export type EventSettingsInput = {
    name?: string | null;
    cventEventId?: string | null;
    cventAppointmentEventId?: string | null;
    cventAppointmentTypeId?: string | null;
};

/** Maps input fields to a normalized (trimmed → null) column patch. */
function toPatch(input: EventSettingsInput) {
    return {
        name: trimToNull(input.name),
        cventEventId: trimToNull(input.cventEventId),
        cventAppointmentEventId: trimToNull(input.cventAppointmentEventId),
        cventAppointmentTypeId: trimToNull(input.cventAppointmentTypeId),
    };
}

/**
 * Creates a new event. The code is required and unique; on success the new
 * event is made the active selection so the form immediately reflects it.
 *
 * @param {{ code: string } & EventSettingsInput} input - New event fields.
 * @returns {Promise<ActionResult>} Created row or a friendly error.
 */
export async function createEvent(
    input: { code: string } & EventSettingsInput,
): Promise<ActionResult> {
    const code = input.code.trim();
    if (!code) return { ok: false, error: "Error: event code is required" };

    try {
        const [event] = await db
            .insert(eventSettings)
            .values({ code, ...toPatch(input) })
            .returning();
        await setActiveEvent(code);
        revalidatePath("/admin", "layout");
        return { ok: true, event };
    } catch (err) {
        return { ok: false, error: describeDbError(err, EVENT_DB_ERROR) };
    }
}

/**
 * Updates an existing event's settings (identified by code). The code itself
 * is immutable here — delete + recreate to rename an event.
 *
 * @param {string} code - The event code to update.
 * @param {EventSettingsInput} input - Fields to change.
 * @returns {Promise<ActionResult>} Updated row or a friendly error.
 */
export async function updateEvent(
    code: string,
    input: EventSettingsInput,
): Promise<ActionResult> {
    try {
        const [event] = await db
            .update(eventSettings)
            .set({ ...toPatch(input), updatedAt: new Date() })
            .where(eq(eventSettings.code, code))
            .returning();
        if (!event) return { ok: false, error: "Error: event not found" };
        revalidatePath("/admin", "layout");
        return { ok: true, event };
    } catch (err) {
        return { ok: false, error: describeDbError(err, EVENT_DB_ERROR) };
    }
}

/**
 * Deletes an event by code. Deleting a non-existent row is treated as success
 * since the end state matches intent.
 *
 * @param {string} code - The event code to delete.
 * @returns {Promise<{ ok: true } | { ok: false; error: string }>} Result.
 */
export async function deleteEvent(
    code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await db.delete(eventSettings).where(eq(eventSettings.code, code));
        revalidatePath("/admin", "layout");
        return { ok: true };
    } catch (err) {
        return { ok: false, error: describeDbError(err, EVENT_DB_ERROR) };
    }
}
