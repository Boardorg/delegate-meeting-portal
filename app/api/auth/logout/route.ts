import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth/session";

// ---------------------------------------------------------------------------
// POST /api/auth/logout — clear the session cookie.
// ---------------------------------------------------------------------------

/**
 * Removes the session cookie.
 *
 * @returns {Promise<NextResponse>} 200 ok.
 */
export async function POST() {
    await destroySession();
    return NextResponse.json({ ok: true });
}
