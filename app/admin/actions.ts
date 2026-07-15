"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { ACTIVE_EVENT_COOKIE } from "@/lib/admin/globalState";

// ---------------------------------------------------------------------------
// Admin-shell server actions (global state mutations).
// ---------------------------------------------------------------------------

/**
 * Sets the admin's active event (stored in the `admin_event` cookie) and
 * revalidates the admin layout so the sidebar switcher and every page pick up
 * the new selection.
 *
 * @param {string} code - The event code to make active.
 */
export async function setActiveEvent(code: string): Promise<void> {
    const cookieStore = await cookies();
    cookieStore.set(ACTIVE_EVENT_COOKIE, code, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        // Persist the selection for a year; it's a UI preference, not a secret.
        maxAge: 60 * 60 * 24 * 365,
    });
    revalidatePath("/admin", "layout");
}
