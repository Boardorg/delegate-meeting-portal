"use server";

import { revalidatePath } from "next/cache";
import { count, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users, type User } from "@/lib/db/schema";
import { normalizePhone } from "@/lib/auth/phone";
import { describeDbError } from "@/lib/db/errors";
import { paginate, type Page } from "@/lib/admin/pagination";

// ---------------------------------------------------------------------------
// Server actions for the /admin/users CRUD UI.
//
// All mutating actions end with revalidatePath('/admin/users') so the page's
// server component re-runs its listUsers() query and the table re-renders
// against the new data — no manual refetch on the client.
// ---------------------------------------------------------------------------

/**
 * Result shape returned by mutating actions. Either `{ ok: true, user }` for
 * success, or `{ ok: false, error }` carrying a user-visible message. We use
 * a discriminated result instead of throwing so the client can render the
 * error inline next to the row that failed.
 */
export type ActionResult<T = User> =
    | { ok: true; user: T }
    | { ok: false; error: string };

// Role values accepted by the DB enum. Kept as a tuple so it can drive both
// the runtime validation and the form's <select> options without drift.
const ROLE_VALUES = ["admin", "user", "sponsor"] as const;
type Role = (typeof ROLE_VALUES)[number];

/**
 * Returns true if `v` is one of the legal role strings.
 */
function isRole(v: unknown): v is Role {
    return (
        typeof v === "string" && (ROLE_VALUES as readonly string[]).includes(v)
    );
}

/**
 * Trims a string field and returns `null` when it ends up empty. Used so the
 * form's blank email/username inputs store as SQL NULL rather than empty
 * strings, which preserves the unique constraint's "allow multiple NULLs"
 * semantics.
 *
 * @param {unknown} v - Raw value from FormData / JSON body.
 * @returns {string | null} The trimmed string, or null if empty / non-string.
 */
function trimToNull(v: unknown): string | null {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t === "" ? null : t;
}

// User-table errors map through the shared describer; the table name lets it
// parse the column out of a `users_<col>_unique` constraint, and `fallback`
// keeps the wording user-specific for anything unrecognized.
const USER_DB_ERROR = { table: "users", fallback: "Error: could not save user" };

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Returns every user, newest first. Called from the page's server component
 * so it runs on the server with no client-visible round trip.
 *
 * @returns {Promise<User[]>} All user rows.
 */
export async function listUsers(): Promise<User[]> {
    return db.select().from(users).orderBy(users.created);
}

/** A page of users plus the totals the table needs. */
export type UsersPage = Page<User>;

/**
 * Returns one page of users, oldest-first. `page` is 1-based.
 *
 * @param {{ page?: number; pageSize?: number }} params - Page number and size.
 * @returns {Promise<UsersPage>} The page of rows plus totals.
 */
export async function listUsersPage(params: {
    page?: number;
    pageSize?: number;
}): Promise<UsersPage> {
    const [{ total }] = await db.select({ total: count() }).from(users);
    const { page, pageSize, pageCount, offset } = paginate(total, params);

    const rows = await db
        .select()
        .from(users)
        .orderBy(users.created)
        .limit(pageSize)
        .offset(offset);

    return { rows, total, page, pageSize, pageCount };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Input shape accepted by createUser. Email and username are optional —
 * phone is the only required field (it's how SMS login looks the user up).
 */
export type CreateUserInput = {
    email?: string | null;
    phone: string;
    username?: string | null;
};

/**
 * Inserts a new user. Phone is normalized to E.164 first; bad phones and
 * unique-constraint failures both come back as `{ ok: false, error }`.
 *
 * @param {CreateUserInput} input - The new user's fields.
 * @returns {Promise<ActionResult>} Created row or a friendly error.
 */
export async function createUser(
    input: CreateUserInput,
): Promise<ActionResult> {
    // Strip formatting noise but keep the entered country-code shape as-is
    // — what's stored here is what the login flow compares against.
    const phone = normalizePhone(input.phone ?? "");
    if (!phone) return { ok: false, error: "Error: invalid phone" };

    try {
        const [user] = await db
            .insert(users)
            .values({
                email: trimToNull(input.email),
                phone,
                username: trimToNull(input.username),
            })
            .returning();
        revalidatePath("/admin/users");
        return { ok: true, user };
    } catch (err) {
        return { ok: false, error: describeDbError(err, USER_DB_ERROR) };
    }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Input shape accepted by updateUser. Every field is optional — the action
 * only writes the keys actually present so the client can do partial
 * patches. `phone`, when provided, must still normalize to E.164.
 */
export type UpdateUserInput = {
    email?: string | null;
    phone?: string;
    username?: string | null;
    role?: Role;
};

/**
 * Patches a user row. Returns `{ ok: false }` for bad phone, unknown role,
 * a missing row, or a unique-constraint conflict.
 *
 * @param {number} id - The user's primary key.
 * @param {UpdateUserInput} input - Fields to change.
 * @returns {Promise<ActionResult>} Updated row or a friendly error.
 */
export async function updateUser(
    id: number,
    input: UpdateUserInput,
): Promise<ActionResult> {
    const patch: Partial<typeof users.$inferInsert> = {};

    if (input.phone !== undefined) {
        const phone = normalizePhone(input.phone);
        if (!phone) return { ok: false, error: "Error: invalid phone" };
        patch.phone = phone;
    }
    if (input.email !== undefined) patch.email = trimToNull(input.email);
    if (input.username !== undefined)
        patch.username = trimToNull(input.username);
    if (input.role !== undefined) {
        if (!isRole(input.role))
            return { ok: false, error: "Error: invalid role" };
        patch.role = input.role;
    }

    if (Object.keys(patch).length === 0) {
        return { ok: false, error: "Error: no changes" };
    }

    try {
        const [user] = await db
            .update(users)
            .set(patch)
            .where(eq(users.id, id))
            .returning();
        if (!user) return { ok: false, error: "Error: user not found" };
        revalidatePath("/admin/users");
        return { ok: true, user };
    } catch (err) {
        return { ok: false, error: describeDbError(err, USER_DB_ERROR) };
    }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Deletes a user by id. Returns `{ ok: false }` only when something at the
 * driver level fails — deleting a non-existent row is treated as success
 * since the end state matches the caller's intent.
 *
 * @param {number} id - The user's primary key.
 * @returns {Promise<{ ok: true } | { ok: false; error: string }>} Result.
 */
export async function deleteUser(
    id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await db.delete(users).where(eq(users.id, id));
        revalidatePath("/admin/users");
        return { ok: true };
    } catch (err) {
        return { ok: false, error: describeDbError(err, USER_DB_ERROR) };
    }
}
