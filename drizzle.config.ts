import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Drizzle-kit runs outside Next.js, so Next's automatic `.env.local` loading
// doesn't apply — load it (and plain `.env` as a fallback) by hand.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// ---------------------------------------------------------------------------
// drizzle-kit configuration
//
// Used by the CLI for `drizzle-kit generate` (build migration SQL from the
// schema), `drizzle-kit migrate` (apply migrations against DATABASE_URL),
// and `drizzle-kit studio` (open the local schema/data browser).
//
// The runtime client in lib/db/client.ts does NOT read this file — it has
// its own connection setup using @neondatabase/serverless.
// ---------------------------------------------------------------------------

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set in .env.local for drizzle-kit.");
}

export default defineConfig({
    dialect: "postgresql",
    schema: "./lib/db/schema.ts",
    out: "./drizzle",
    dbCredentials: {
        url: process.env.DATABASE_URL,
    },
    // Verbose output makes the `generate` diff easy to eyeball before applying.
    verbose: true,
    strict: true,
});
