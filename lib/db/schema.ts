import {
    boolean,
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

/** How a scheduled meeting was created and which party's request drove it. */
export const meetingMatchKind = pgEnum("meeting_match_kind", [
    "mutual",
    "sponsor_choice",
    "delegate_choice",
    "admin",
]);

/** Where a meeting originates. Cvent-native meetings are read-only in the portal. */
export const meetingSource = pgEnum("meeting_source", ["portal", "cvent"]);

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
        eventCode: text("event_code").notNull(),
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

/**
 * Persisted scheduled meetings. One row per confirmed meeting, scoped to an event.
 * Engine-produced rows are inserted in bulk after runScheduler; admin-created rows
 * are inserted individually. Cvent-native rows (source='cvent') are read-only in
 * the portal — no edit, remove, or push actions apply.
 *
 * Sync status is derived at read time:
 *   - cventAppointmentId === null → not pushed
 *   - lastModifiedAt > lastPushedAt → modified since last push
 *   - otherwise → pushed/synced
 */
export const scheduledMeetings = pgTable("scheduled_meetings", {
    // Engine generates 'mtg-001' style ids; admin-created rows use a UUID.
    id: text("id").primaryKey(),

    eventCode: text("event_code").notNull(),

    // Attendee ids (Salesforce ids, matching MeetingRequest.requesterId/targetId).
    attendeeA: text("attendee_a").notNull(),
    attendeeB: text("attendee_b").notNull(),

    // 1 = Day 1 (sponsor/delegate), 2 = Day 2 (delegate/delegate).
    day: integer("day").notNull(),

    // Slot ids from each attendee's AttendeeSlot[]. Used to look up start/end times.
    slotIdA: text("slot_id_a").notNull(),
    slotIdB: text("slot_id_b").notNull(),

    // Engine pass that produced this meeting (1–7). 0 for admin-created.
    passNumber: integer("pass_number").notNull(),

    mutual: boolean("mutual").notNull(),
    matchKind: meetingMatchKind("match_kind").notNull(),

    // Requester's interest level at scheduling time. Null for admin/cvent-native rows.
    rank: integer("rank"),

    source: meetingSource("source").notNull().default("portal"),

    // Admin-assigned location (e.g. "Table 3A"). Null until set.
    location: text("location"),

    // ISO 8601 strings matching the assigned AttendeeSlot times.
    startTime: text("start_time"),
    endTime: text("end_time"),

    // Null until the meeting has been pushed to Cvent.
    cventAppointmentId: text("cvent_appointment_id"),

    // Null if never manually edited since creation or last push.
    lastModifiedAt: timestamp("last_modified_at", { withTimezone: true }),

    // Null if never pushed. Modified = lastModifiedAt > lastPushedAt.
    lastPushedAt: timestamp("last_pushed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});

export type ScheduledMeetingRow = typeof scheduledMeetings.$inferSelect;
export type NewScheduledMeeting = typeof scheduledMeetings.$inferInsert;
