import { config as loadEnv } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

// ---------------------------------------------------------------------------
// Migration runner (`npm run db:migrate`)
//
// Applies the SQL migrations in ./drizzle against DATABASE_URL.
//
// Why this instead of `drizzle-kit migrate`? drizzle-kit's migrate uses Neon's
// WebSocket *serverless* driver, which fails silently on newer Node runtimes
// (the process exits non-zero after "applying migrations..." with no error and
// the migration is never applied). This runner uses the same Neon *HTTP*
// driver as the app's runtime client (lib/db/client.ts) — the connection path
// that actually works here — and surfaces the real Postgres error on failure.
//
// It reads the same migration journal drizzle-kit writes, so `db:generate`
// continues to work unchanged; only the apply step moves off the websocket
// driver.
// ---------------------------------------------------------------------------

// Scripts run outside Next.js, so load .env.local (then .env as a fallback) by
// hand — mirrors drizzle.config.ts.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

/** Applies all pending migrations, then exits. */
async function main() {
    const url = process.env.DATABASE_URL;
    if (!url) {
        throw new Error(
            "DATABASE_URL must be set in .env.local to run migrations.",
        );
    }

    const db = drizzle(neon(url));
    console.log("Applying migrations from ./drizzle …");
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("Migrations applied.");
}

main().catch((err) => {
    // Print the real underlying error (the thing drizzle-kit was hiding) and
    // fail loudly so CI / the shell sees a non-zero exit.
    console.error("Migration failed:");
    console.error(err);
    process.exit(1);
});
