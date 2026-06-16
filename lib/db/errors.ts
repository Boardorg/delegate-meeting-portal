// ---------------------------------------------------------------------------
// DB error mapping — turns a thrown drizzle/neon error into a friendly,
// user-visible message for the admin CRUD UIs.
//
// Drizzle wraps query failures in a `DrizzleQueryError` whose `.cause` is the
// driver-level error (NeonDbError, pg.DatabaseError, …), so the SQLSTATE
// fields live a few links down the chain. We walk the chain, map the two
// codes the forms can actually hit (unique 23505, not-null 23502), and fall
// back to a cleaned-up message for everything else — never a raw SQL dump.
// ---------------------------------------------------------------------------

/**
 * The Postgres-level error fields we care about. Both `pg` and
 * `@neondatabase/serverless` populate these.
 */
type PgError = {
    code?: string;
    constraint?: string;
    detail?: string;
    message?: string;
};

/**
 * Walks the `.cause` chain to find the first error carrying a SQLSTATE code.
 *
 * @param {unknown} err - The thrown error from drizzle.
 * @returns {PgError | null} The driver-level error, or null.
 */
function findPgError(err: unknown): PgError | null {
    let cur: unknown = err;
    for (let depth = 0; cur && depth < 5; depth++) {
        const e = cur as PgError & { cause?: unknown };
        if (typeof e.code === "string") return e;
        cur = e.cause;
    }
    return null;
}

/**
 * Extracts the column from a `<table>_<field>_unique` constraint name
 * (drizzle's default for `.unique()` columns). Returns null if the name
 * doesn't match the convention for the given table.
 */
function fieldFromConstraint(
    name: string | undefined,
    table: string | undefined,
): string | null {
    if (!name || !table) return null;
    const m = new RegExp(`^${table}_(.+)_unique$`).exec(name);
    return m?.[1] ?? null;
}

/**
 * Options for tailoring the message to a specific table.
 */
export type DescribeDbErrorOptions = {
    /** Table name, used to parse the column out of a unique-constraint name. */
    table?: string;
    /**
     * Message to use for any unique-constraint (23505) violation. Use this
     * for composite constraints where naming a single column would mislead
     * (e.g. "a request for this requester and target already exists").
     */
    uniqueMessage?: string;
    /** Fallback when no specific mapping applies. */
    fallback?: string;
};

/**
 * Maps a Postgres error into a friendly message for the admin UI.
 *
 * @param {unknown} err - The error thrown by drizzle/neon.
 * @param {DescribeDbErrorOptions} [opts] - Table name + message overrides.
 * @returns {string} A message suitable for showing to the admin user.
 */
export function describeDbError(
    err: unknown,
    opts: DescribeDbErrorOptions = {},
): string {
    const pg = findPgError(err);

    if (pg?.code === "23505") {
        if (opts.uniqueMessage) return opts.uniqueMessage;
        const field =
            fieldFromConstraint(pg.constraint, opts.table) ??
            /Key \(([^)]+)\)/.exec(pg.detail ?? "")?.[1] ??
            "value";
        return `Error: duplicate ${field}`;
    }

    if (pg?.code === "23502") {
        const m = /column "([^"]+)"/.exec(pg.detail ?? pg.message ?? "");
        return m ? `Error: missing ${m[1]}` : "Error: missing required field";
    }

    // Anything else: keep the underlying message but strip drizzle's
    // "Failed query: <SQL> params: …" wrapper so the user sees something
    // readable instead of a SQL dump.
    const raw =
        pg?.message ?? (err instanceof Error ? err.message : String(err));
    const cleaned = raw.replace(/^Failed query:[\s\S]*/u, "").trim();
    return cleaned ? `Error: ${cleaned}` : (opts.fallback ?? "Error: operation failed");
}
