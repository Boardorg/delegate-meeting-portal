import "server-only";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// ---------------------------------------------------------------------------
// Drizzle + Neon client
//
// Uses Neon's HTTP driver (no persistent socket) which works in every Next.js
// runtime — Node, Edge, and serverless — without connection pooling concerns.
// One query = one HTTPS request to Neon, so we don't need to manage a pool.
//
// The drizzle instance is cached on globalThis so Next.js hot-reload in dev
// doesn't construct a fresh client on every module reload.
// ---------------------------------------------------------------------------

/**
 * Reads DATABASE_URL from the environment and throws a clear error if it's
 * missing — surfaces a config problem at the boundary instead of an opaque
 * driver-level error downstream.
 *
 * @returns {string} The validated connection string.
 */
function readDatabaseUrl(): string {
    const url = process.env.DATABASE_URL;
    if (!url) {
        throw new Error(
            "Missing DATABASE_URL env var — required to connect to Neon Postgres.",
        );
    }
    return url;
}

// Type of the drizzle client we expose. Inferred from the factory call below
// so the schema's table types flow through to db.query.* without extra wiring.
type Db = ReturnType<typeof buildClient>;

/**
 * Builds a fresh Neon-backed drizzle client. Factored out so the
 * dev-mode singleton cache and the production path both go through the
 * same construction logic.
 *
 * @returns {ReturnType<typeof drizzle>} A new drizzle client bound to schema.
 */
function buildClient() {
    const sql = neon(readDatabaseUrl());
    return drizzle(sql, { schema });
}

// In dev, Next.js may re-evaluate this module multiple times due to hot
// reload — caching on globalThis prevents leaking one client per reload.
// In production each Node process gets exactly one client.
const globalForDb = globalThis as unknown as { __db?: Db };

/**
 * The shared drizzle client. Import this in server components, route
 * handlers, and server actions:
 *
 *   import { db } from "@/lib/db/client";
 *   const rows = await db.select().from(users);
 */
export const db: Db = globalForDb.__db ?? buildClient();

if (process.env.NODE_ENV !== "production") {
    globalForDb.__db = db;
}
