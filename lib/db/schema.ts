import {
    boolean,
    integer,
    jsonb,
    pgEnum,
    pgTable,
    serial,
    text,
    timestamp,
    unique,
} from "drizzle-orm/pg-core";
import type { AppointmentTypeKinds } from "@/lib/events/meetingKinds";
import type { BoothLocations } from "@/lib/scheduling/booths";
import type { StoredMatchingSettings } from "@/lib/matching/settings";

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

/**
 * How a scheduled meeting was created and which party's request drove it.
 * `profile_match` is a delegate-to-delegate meeting the D2D engine paired from profile answers.
 */
export const meetingMatchKind = pgEnum("meeting_match_kind", [
    "mutual",
    "sponsor_choice",
    "delegate_choice",
    "admin",
    "profile_match",
]);
export type MeetingMatchKind = (typeof meetingMatchKind.enumValues)[number];

/** Where a meeting originates. Cvent-native meetings are read-only in the portal. */
export const meetingSource = pgEnum("meeting_source", ["portal", "cvent"]);
export type MeetingSource = (typeof meetingSource.enumValues)[number];

/**
 * The kinds of meeting stored in scheduled_meetings.
 * Each scheduler run replaces only the unpushed meetings of its own kind.
 */
export type ScheduledMeetingKind = "sponsor_delegate" | "delegate_delegate";

/** Whether a delegate holds a seat at a roundtable or is one of its alternates. */
export const roundtableSeatRole = pgEnum("roundtable_seat_role", [
    "seated",
    "alternate",
]);
export type RoundtableSeatRole = (typeof roundtableSeatRole.enumValues)[number];

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
        // Salesforce ID of the sponsor submitting the request.
        requesterId: text("requester_id").notNull(),
        // Salesforce ID of the delegate being requested.
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
            t.eventCode,
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
 *
 * lastPushedAt is kept when a meeting is unpushed, so a not-pushed row can still have one.
 * The push uses it to build a fresh Cvent appointment code (see appointmentCode() in lib/cvent/push.ts).
 */
export const scheduledMeetings = pgTable("scheduled_meetings", {
    // Engine generates 'mtg-001' style ids; admin-created rows use a UUID.
    id: text("id").primaryKey(),

    eventCode: text("event_code").notNull(),

    // Which kind of meeting this is.
    // Rows made before delegate-to-delegate matching are all sponsor meetings, hence the default.
    kind: text("kind")
        .$type<ScheduledMeetingKind>()
        .notNull()
        .default("sponsor_delegate"),

    // Party ids (matching MeetingRequest.requesterId/targetId).
    // attendee_a is the sponsor company on an S2D meeting.
    // That is its Account id, whichever side requested it, and attendee_b is the delegate.
    // Queries here filter on that.
    // On a D2D meeting attendee_a is the host delegate and attendee_b the other delegate.
    // See ScheduledMeeting in types/index.ts for the invariant.
    attendeeA: text("attendee_a").notNull(),
    attendeeB: text("attendee_b").notNull(),

    // 1 = Day 1, 2 = Day 2, from the booked timeslot's date.
    // Sponsor meetings are on Day 1, or Day 2 for a diamond sponsor's spillover.
    day: integer("day").notNull(),

    // Cvent timeslot id (Timeslot.id). Shared by both attendees; start/end times
    // are resolved from the event's Cvent timeslots at read time, not stored here.
    timeslotId: text("timeslot_id").notNull(),

    // Engine pass that produced this meeting (1–5 for sponsor meetings). 0 for admin-created.
    // D2D meetings use D2D_PASS_NUMBER from lib/matching/d2d.ts.
    passNumber: integer("pass_number").notNull(),

    mutual: boolean("mutual").notNull(),
    matchKind: meetingMatchKind("match_kind").notNull(),

    // Requester's interest level at scheduling time. Null for admin/cvent-native rows.
    rank: integer("rank"),

    source: meetingSource("source").notNull().default("portal"),

    // Cvent location id (Location.id). Seeded from the timeslot's native location
    // by the engine, independently editable by an admin. Null until assigned.
    // The location name is resolved from the event's Cvent locations at read time.
    locationId: text("location_id"),

    // Null until the meeting has been pushed to Cvent.
    cventAppointmentId: text("cvent_appointment_id"),

    // Null if never manually edited since creation or last push.
    lastModifiedAt: timestamp("last_modified_at", { withTimezone: true }),

    // Time of the last successful push. Null if never pushed.
    // Kept when the meeting is unpushed, since the next push builds its Cvent code from it.
    // Modified = lastModifiedAt > lastPushedAt, while the meeting is still pushed.
    lastPushedAt: timestamp("last_pushed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});

export type ScheduledMeetingRow = typeof scheduledMeetings.$inferSelect;
export type NewScheduledMeeting = typeof scheduledMeetings.$inferInsert;

/**
 * Per-event configuration, one row per event. Holds the Cvent identifiers the
 * integration needs (event id and appointment-event id used in API paths).
 *
 * This table is also the registry that drives the global event dropdown, so an
 * event must have a row here to be selectable in the admin UI.
 */
export const eventSettings = pgTable("event_settings", {
    id: serial("id").primaryKey(),

    // Internal event code (e.g. "BMWS"), matching meeting_requests.event_code
    // and scheduled_meetings.event_code. Unique — one settings row per event.
    code: text("code").notNull().unique(),

    // Optional human-friendly label shown in the event dropdown.
    name: text("name"),

    // Optional per-event brand color (hex, e.g. "#089e9d"). When set it drives
    // the frontend's --accent primary accent; when null the CSS fallback (the
    // default Assemble teal in globals.css) is used instead.
    themeColor: text("theme_color"),

    // Optional per-event logo URL, shown in the header next to the Assemble
    // mark. An absolute (https://…) or root-relative (/…) URL; null hides it.
    logoUrl: text("logo_url"),

    // Cvent Event id (the overall event).
    cventEventId: text("cvent_event_id"),

    // Cvent appointment-event id — the `{id}` in /ea/appointment-events/{id}/...
    // that every appointment API call uses.
    cventAppointmentEventId: text("cvent_appointment_event_id"),

    // Maps each Cvent appointment-type id to a meeting kind, set in Event settings.
    // For example { "fc560dc7-...": "sponsor_delegate" }.
    // A type with no entry behaves as "ignore". Null when nothing is mapped yet.
    // See lib/events/meetingKinds.ts.
    appointmentTypeKinds: jsonb(
        "appointment_type_kinds",
    ).$type<AppointmentTypeKinds>(),

    // Maps a sponsor booth number to a Cvent location id, set on the Sponsor booths page.
    // For example { "3": "a1c30445-..." }.
    // Booth numbers are stored trimmed.
    // Salesforce still decides which company has which booth number.
    // A booth number with no entry uses the automatic match by location name.
    // Null when nothing is mapped yet.
    // See lib/scheduling/booths.ts.
    boothLocations: jsonb("booth_locations").$type<BoothLocations>(),

    // Delegate matching settings, set on the Matching Settings page.
    // Holds the D2D and roundtable question order and on/off switches, the meeting caps,
    // seats and alternates per table, and the minimum match scores.
    // Null means the code defaults.
    // See lib/matching/settings.ts.
    matchingSettings: jsonb(
        "matching_settings",
    ).$type<StoredMatchingSettings>(),

    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});

export type EventSettingsRow = typeof eventSettings.$inferSelect;
export type NewEventSettings = typeof eventSettings.$inferInsert;

/**
 * Delegate group roundtables, one row per table.
 * Each table is one Cvent timeslot mapped to `delegate_group`, at that timeslot's location.
 * The roundtable engine creates the rows, and admins add the theme title and edit the description.
 *
 * Sync status works like scheduled_meetings (see lib/cvent/syncStatus.ts).
 * Pushing a roundtable sends it to Cvent as one delegate_group appointment (see lib/cvent/roundtablePush.ts).
 */
export const roundtables = pgTable(
    "roundtables",
    {
        // The engine generates 'rt-001' style ids with a timestamp suffix, like meetings.
        id: text("id").primaryKey(),

        eventCode: text("event_code").notNull(),

        // Cvent timeslot id (Timeslot.id) of the table's delegate_group slot.
        // Start and end times are resolved from the event's Cvent timeslots at read time.
        timeslotId: text("timeslot_id").notNull(),

        // Cvent location id of the table, from the timeslot. Null when Cvent omits it.
        locationId: text("location_id"),

        // Typed by an admin after grouping. It becomes the Cvent appointment's subject.
        themeTitle: text("theme_title"),

        // It becomes the Cvent appointment's description, exactly as stored.
        // New tables start with the default host note, and admins can edit or clear it.
        // Null or empty means an empty description.
        description: text("description"),

        // Null until the roundtable has been pushed to Cvent.
        cventAppointmentId: text("cvent_appointment_id"),

        // Set when an admin edits the theme, the description or the seated delegates.
        lastModifiedAt: timestamp("last_modified_at", { withTimezone: true }),

        // Time of the last successful push. Null if never pushed.
        lastPushedAt: timestamp("last_pushed_at", { withTimezone: true }),

        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (t) => [
        unique("roundtables_event_timeslot_unique").on(
            t.eventCode,
            t.timeslotId,
        ),
    ],
);

export type RoundtableRow = typeof roundtables.$inferSelect;
export type NewRoundtable = typeof roundtables.$inferInsert;

/**
 * The delegates at each roundtable, seated or alternate.
 * A delegate has at most one row per event, so they can't be at two tables.
 * Deleting a roundtable deletes its seats.
 */
export const roundtableSeats = pgTable(
    "roundtable_seats",
    {
        id: serial("id").primaryKey(),

        // Repeated from the roundtable so the per-event unique constraint below can use it.
        eventCode: text("event_code").notNull(),

        roundtableId: text("roundtable_id")
            .notNull()
            .references(() => roundtables.id, { onDelete: "cascade" }),

        // The delegate's Salesforce id, the same party id scheduled_meetings uses.
        delegateId: text("delegate_id").notNull(),

        role: roundtableSeatRole("role").notNull(),

        // Order within the role at the table, starting at 1.
        position: integer("position").notNull(),

        // Why they were picked, for example "Both: Leadership Development, Workday".
        // Null for a delegate an admin moved here by hand.
        reason: text("reason"),

        // Their match score with the table, 0 to 100.
        // Null for a delegate an admin moved here by hand.
        score: integer("score"),

        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (t) => [
        unique("roundtable_seats_event_delegate_unique").on(
            t.eventCode,
            t.delegateId,
        ),
    ],
);

export type RoundtableSeatRow = typeof roundtableSeats.$inferSelect;
export type NewRoundtableSeat = typeof roundtableSeats.$inferInsert;
