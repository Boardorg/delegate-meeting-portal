"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { ACTIVE_EVENT_COOKIE, SPOOF_SPONSOR_COOKIE } from "@/lib/auth/session";

// ---------------------------------------------------------------------------
// Admin-shell server actions (global state mutations).
// ---------------------------------------------------------------------------

// Persist selections for a year; they're UI preferences, not secrets.
const COOKIE_OPTS = {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
} as const;

/**
 * Sets the admin's active event (stored in the `admin_event` cookie) and
 * revalidates the admin layout so the sidebar switcher and every page pick up
 * the new selection.
 *
 * @param {string} code - The event code to make active.
 */
export async function setActiveEvent(code: string): Promise<void> {
    const cookieStore = await cookies();
    cookieStore.set(ACTIVE_EVENT_COOKIE, code, COOKIE_OPTS);
    revalidatePath("/admin", "layout");
}

/**
 * Sets the sponsor an admin spoofs on the frontend while in testing mode
 * (stored in the `admin_spoof_sponsor` cookie). Revalidates the admin layout
 * (to update the switcher) and the frontend home so the spoofed identity there
 * reflects the new selection.
 *
 * @param {string} salesforceId - The Salesforce id of the sponsor to spoof.
 */
export async function setSpoofSponsor(salesforceId: string): Promise<void> {
    const cookieStore = await cookies();
    cookieStore.set(SPOOF_SPONSOR_COOKIE, salesforceId, COOKIE_OPTS);
    revalidatePath("/admin", "layout");
    revalidatePath("/");
}
