import { config as loadEnv } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { readMigrationFiles } from "drizzle-orm/migrator";

// ---------------------------------------------------------------------------
// One-time migration-history baseline (`npm run db:baseline`)
//
// The Neon database's schema was brought up to date without recording anything
// in Drizzle's history table (drizzle.__drizzle_migrations) — most likely via
// `drizzle-kit push`. Because that table is empty, `db:migrate` thinks NO
// migrations have run and replays from 0000 ("CREATE TABLE ... already
// exists"), so it never reaches new migrations.
//
// This script seeds the history table to reflect reality: it marks every
// migration EXCEPT the newest as already-applied, using Drizzle's own hashes
// and timestamps. After running it once, `npm run db:migrate` applies only the
// genuinely-pending migration(s) and future migrations work normally.
//
// It is idempotent — a migration already recorded (matched by timestamp) is
// skipped — so re-running it is safe.
// ---------------------------------------------------------------------------

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

async function main() {
    const url = process.env.DATABASE_URL;
    if (!url) {
        throw new Error(
            "DATABASE_URL must be set in .env.local to baseline migrations.",
        );
    }
    const sql = neon(url);

    // All migrations in journal order. Everything but the last is assumed
    // already applied to the DB (the newest is the one db:migrate should run).
    const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" });
    if (migrations.length < 2) {
        console.log("Nothing to baseline (fewer than 2 migrations).");
        return;
    }
    const alreadyApplied = migrations.slice(0, -1);
    const newest = migrations[migrations.length - 1];

    // Match drizzle-orm/neon-http/migrator: schema `drizzle`, table
    // `__drizzle_migrations` (id serial, hash text, created_at bigint).
    await sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`;
    await sql`
        CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
            id SERIAL PRIMARY KEY,
            hash text NOT NULL,
            created_at bigint
        )
    `;

    // Existing timestamps → skip re-inserting them (idempotent).
    const existing = await sql`
        SELECT created_at FROM "drizzle"."__drizzle_migrations"
    `;
    const seen = new Set(existing.map((r) => String(r.created_at)));

    let inserted = 0;
    for (const m of alreadyApplied) {
        if (seen.has(String(m.folderMillis))) continue;
        await sql`
            INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
            VALUES (${m.hash}, ${m.folderMillis})
        `;
        inserted++;
    }

    console.log(
        `Baseline complete: recorded ${inserted} migration(s) as applied ` +
            `(${alreadyApplied.length} total already-applied, ` +
            `${seen.size} were already recorded).`,
    );
    console.log(
        `Newest migration left pending for db:migrate: ` +
            `folderMillis=${newest.folderMillis}.`,
    );
    console.log("Now run: npm run db:migrate");
}

main().catch((err) => {
    console.error("Baseline failed:");
    console.error(err);
    process.exit(1);
});
