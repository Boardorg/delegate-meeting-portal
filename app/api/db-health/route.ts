import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

// ---------------------------------------------------------------------------
// GET /api/db-health — round-trip a trivial query to Neon as a smoke test.
//
// Returns 200 with `{ ok: true }` when the connection works, or 500 with the
// error message when it doesn't. Useful for verifying DATABASE_URL is wired
// correctly without needing any application tables.
// ---------------------------------------------------------------------------

/**
 * Pings the database with `SELECT 1`.
 *
 * @returns {Promise<NextResponse>} 200 ok on success, 500 with details on failure.
 */
export async function GET() {
    try {
        // Use a raw `sql` template so this works whether or not schema tables exist.
        await db.execute(sql`SELECT 1`);
        return NextResponse.json({ ok: true });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
}
