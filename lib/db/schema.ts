import {
    integer,
    pgEnum,
    pgTable,
    serial,
    text,
    timestamp,
    unique,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Drizzle schema
//
// Tables are declared here using drizzle-orm's pg-core builders. Each table
// is also exported so application code can import it for typed queries:
//
//   import { db } from "@/lib/db/client";
//   import { users } from "@/lib/db/schema";
//   await db.select().from(users);
//
// To add a column or table:
//   1. Edit this file.
//   2. Run `npm run db:generate` to produce a SQL migration in drizzle/.
//   3. Run `npm run db:migrate` to apply it to the database.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Application roles. Stored as a Postgres enum so a typo or bad value is
 * rejected at the DB layer. Add new roles here, then re-generate migrations.
 */
export const userRole = pgEnum("user_role", ["admin", "user", "sponsor"]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * Portal users. One row per person who can log in. The `phone` column is
 * the join key with the SMS login flow — login normalizes to E.164 and the
 * session cookie carries the same value.
 */
export const users = pgTable("users", {
    // Auto-incrementing integer PK (Postgres `serial`).
    id: serial("id").primaryKey(),

    // Contact + identity columns. Phone is the only required identifier
    // (the SMS login flow uses it as the user's key). Email and username
    // are optional but still unique when present so duplicates fail loudly.
    email: text("email").unique(),
    phone: text("phone").notNull().unique(),
    username: text("username").unique(),

    // Optional Salesforce Attendee/Contact id. Set for locally-managed rows
    // (e.g. an admin or manually-added sponsor) so their SF record can be
    // referenced when attaching requests/schedules. Unique when present.
    // Frontend users matched live from Salesforce carry their id on the
    // resolved identity instead (see lib/auth/identity.ts).
    salesforceId: text("salesforce_id").unique(),

    // Authorization level — see the `userRole` enum above.
    role: userRole("role").notNull().default("admin"),

    // Audit timestamps. `created` is stamped by Postgres on insert;
    created: timestamp("created", { withTimezone: true })
        .notNull()
        .defaultNow(),
    lastLogin: timestamp("last_login", { withTimezone: true }),
});

// Inferred row types for use in app code:
//   `User`     — what a SELECT returns
//   `NewUser`  — what an INSERT accepts (auto-generated columns optional)
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/**
 * Sponsor meeting requests. One row per (requester, target) pair. Rank 1–5
 * expresses interest level; rank 0 is never stored — the route deletes the
 * row instead, so the table only contains active requests.
 *
 * The unique constraint on (requester_id, target_id) enables upsert semantics:
 * submitting the same pair with a new rank updates rather than duplicates.
 */
export const meetingRequests = pgTable(
    "meeting_requests",
    {
        id: serial("id").primaryKey(),
        // Attendee.id of the sponsor submitting the request.
        requesterId: text("requester_id").notNull(),
        // Attendee.id of the delegate being requested.
        targetId: text("target_id").notNull(),
        rank: integer("rank").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (t) => [
        unique("meeting_requests_requester_target_unique").on(
            t.requesterId,
            t.targetId,
        ),
    ],
);

export type MeetingRequestRow = typeof meetingRequests.$inferSelect;
export type NewMeetingRequest = typeof meetingRequests.$inferInsert;
