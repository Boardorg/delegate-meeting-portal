import type { User, MeetingMatchKind, MeetingSource } from "@/lib/db/schema";

export type CachedAuth = {
    accessToken: string;
    instanceUrl: string;
    expiresAt: number;
};

export type AttendeeRecordSF = {
    Id: string;
    Name: string;
    [key: string]: unknown;
};

/**
 * Attendee role. Determines scheduling rules, day eligibility, and meeting caps.
 * - `delegate`: Event attendee; eligible for sponsor meetings on Day 1 and peer meetings on Day 2.
 * - `sponsor`: Paying sponsor; eligible for delegate meetings on Day 1 only.
 */
export type AttendeeRole = "delegate" | "sponsor";

/**
 * Sponsor package tier. Determines the sponsor's meeting cap in Pass 5.
 * - `diamond`: Highest tier; guaranteed 8 package meetings, cap raised to 10 in Pass 5.
 * - `standard`: All other tiers; guaranteed 5 package meetings, cap raised to 7 in Pass 5.
 * - `null`: Not applicable (delegates).
 */
export type SponsorTier = "diamond" | "standard" | null;


/**
 * A single bookable time block for an event, sourced from Cvent's
 * "List Available Times" API and shared by all attendees (event-global, not
 * per-attendee). The engine assigns meetings to timeslots, honoring capacity
 * and preventing an attendee from being double-booked at the same start time.
 *
 * Cvent binds each available-time to a location; `locationId` is that native
 * location and is used as the default location for meetings booked here.
 */
export interface Timeslot {
    /** Cvent available-time id. Stored on ScheduledMeeting.timeslotId. */
    id: string;

    /** The event day this timeslot belongs to. Day 1 = sponsor/delegate; Day 2 = delegate/delegate. */
    day: 1 | 2;

    /** ISO 8601 UTC start time, sourced from Cvent. */
    startTime: string;

    /** ISO 8601 UTC end time, sourced from Cvent. */
    endTime: string;

    /**
     * How many meetings may book this timeslot, from Cvent's availableAppointments.
     * Infinity when Cvent reports unlimited (-1) or omits the value.
     */
    capacity: number;

    /** Cvent location bound to this timeslot. Null when Cvent omits it. */
    locationId: string | null;

    /** Cvent appointment-type id this timeslot belongs to (e.g. a specific networking break). */
    appointmentTypeId: string;
}

/**
 * A bookable location (room, table, booth) for an event, sourced from Cvent's
 * "List Locations" API. Meetings reference a location by id.
 */
export interface Location {
    /** Cvent location id. Stored on ScheduledMeeting.locationId. */
    id: string;

    /** Human-readable location name (e.g. "Table 3A", "Conference Room B"). */
    name: string;

    /** Max occupancy from Cvent. Infinity when Cvent reports unlimited (-1) or omits the value. */
    capacity: number;

    /** Parent location id when this location is nested (e.g. a table within a room). Null for top-level. */
    parentLocationId: string | null;
}

/**
 * Profile attributes used by the browse and filter UI when attendees are submitting meeting requests.
 * These fields are not used by the scheduling engine.
 */
export interface AttendeeProfile {
    /**
     * Attendee's company annual revenue range.
     * Null for sponsors.
     * Example values: '<10M' | '10M-50M' | '50M-100M' | '100M-500M' | '500M-1B' | '1B-5B' | '>5B'
     */
    annualRevenue: number | string | null;

    /**
     * Attendee's budgetary responsibility level.
     * Null for sponsors.
     * Example values: '<1M' | '1M-10M' | '10M-50M' | '50M-100M' | '100M-500M' | '500M-1B' | '>1B'
     */
    budgetaryResponsibility: string | null;

    /**
     * The attendee's areas of professional specialization.
     * Example values: ['cybersecurity', 'cloud infrastructure', 'AI/ML']
     */
    areasOfSpecialization: string[];

    /**
     * The industry sector the attendee's company operates in.
     * Example values: ['technology', 'healthcare', 'financial services', 'manufacturing']
     */
    industrySectors: string[];

    /**
     * Planned company spend on the attendee's selected areas of specialization over the next 12–24 months.
     * Example values: '<1M' | '1M-5M' | '5M-25M' | '25M-100M' | '>100M'
     */
    plannedSpend: string | null;

    /**
     * Attendee's company size.
     * Null for sponsors.
     * Example values: '1-50' | '51-200' | '200-500' | '500-1000' | '1000-5000' | '>5000'
     */
    companySize: number | string | null;

    /**
     * The geographic regions the attendee oversees or is responsible for.
     * Example values: ['North America', 'EMEA', 'APAC', 'LATAM']
     */
    regionsOverseen: string[];

    /**
     * The attendee's top strategic priorities for the coming year.
     * Example values: ['cost reduction', 'digital transformation', 'talent acquisition']
     */
    strategicPriorities: string[];
}

/**
 * The single event attendee object.
 * Contains all relevant information about an attendee. The primary input to the scheduling engine.
 */
export interface Attendee {
    /** Internal app identifier. Referenced by all other objects (requests, meetings, schedules). */
    id: string;

    /**
     * Cvent contact UUID for this attendee.
     * Used to verify identity during the Dynamic URL auth flow and to write
     * appointments back to Cvent after scheduling.
     */
    cventContactId: string;

    /**
     * Salesforce Contact/Attendee record ID.
     * Used by the Salesforce integration to query and update the correct record.
     */
    salesforceId: string;

    /** Full display name. */
    name: string;

    /** Email address. */
    email: string;

    /**
     * Contact phone number (raw from Salesforce/source data).
     * Used to match the SMS-login phone to this attendee when the user is not
     * in the local users table. See lib/auth/identity.ts.
     */
    phone: string;

    /** Attendee role. */
    role: AttendeeRole;

    /** Attendee's company name. */
    company: string;

    /** Job title. Used in the browse and filter UI. */
    title: string;

    /**
     * Sponsor package tier. Determines meeting caps in Pass 5.
     * Null for delegates.
     */
    sponsorTier: SponsorTier;

    /** Profile attributes used by the browse and filter UI. */
    profile: AttendeeProfile;

    /**
     * Existing scheduling constraints for this attendee. Availability is no
     * longer per-attendee — it comes from the event-global Timeslot[] passed to
     * the engine — so only the company-diversity cap lives here.
     */
    scheduling: {
        /**
         * Maximum number of meetings this attendee can have with people from the same company.
         * Null for sponsors because the rule does not apply to them (@todo need to confirm this).
         */
        maxSameCompanyMeetings: number | null;
    };
}

/**
 * An Attendee extended with computed per-event stats for the admin detail view.
 * Used as the sponsor prop on the per-sponsor meeting detail page.
 * sponsorTier is narrowed to non-null because only sponsor attendees reach that page.
 */
export type SponsorDetail = Attendee & {
    sponsorTier: "diamond" | "standard";
    contracted: number;
    bonus: number;
    requestCount: number;
    scheduledCount: number;
};

/**
 * A single meeting request submitted by an attendee to meet another attendee.
 */
export interface MeetingRequest {
    /** Unique identifier for this request. */
    id: string;

    /** Attendee ID of the person submitting the request. */
    requesterId: string;

    /** Attendee ID of the desired meeting partner. */
    targetId: string;

    /**
     * Interest level on a scale of 1–5. 5 = highest interest, 1 = lowest.
     * Multiple targets may share the same rank.
     */
    rank: number;
}

/**
 * A single confirmed meeting produced by the scheduling engine.
 *
 * Meetings are thin id references: `timeslotId` and `locationId` point into the
 * event-global Timeslot[]/Location[] (sourced from Cvent). Display values
 * (start/end time, location name) are resolved from those by joining at read
 * time — they are not stored on the meeting.
 */
export interface ScheduledMeeting {
    /** Unique identifier for this scheduled meeting. */
    id: string;

    /** Attendee ID of the first participant. */
    attendeeA: string;

    /** Attendee ID of the second participant. */
    attendeeB: string;

    /** The event day on which this meeting is scheduled. */
    day: 1 | 2;

    /** The Timeslot.id assigned to this meeting. Shared by both attendees. */
    timeslotId: string;

    /**
     * Which algorithm pass produced this meeting (1–7).
     * Retained on output for auditing, spot-checking, and human review.
     * 0 for admin-created meetings (no engine pass).
     */
    passNumber: number;

    /**
     * Whether both attendees requested each other.
     * Computed by the engine at runtime and stored on the output for transparency.
     * Always false for admin-created meetings.
     */
    mutual: boolean;

    /**
     * How this meeting was created and which party's request drove the pairing.
     * Set by the engine for engine-produced meetings; set to 'admin' for manually created meetings.
     */
    matchKind: MeetingMatchKind;

    /**
     * Interest level (1–5) assigned by the requester for this pairing.
     * Sourced from the requester's MeetingRequest.rank at scheduling time.
     * Null for admin-created meetings and Cvent-native meetings (no underlying request).
     */
    rank: number | null;

    /**
     * Where this meeting originates. Portal-managed meetings are editable in the admin UI;
     * Cvent-native meetings are read-only.
     */
    source: MeetingSource;

    /**
     * The Location.id for this meeting. Seeded by the engine from the booked
     * timeslot's native location, but independently editable by an admin.
     * Null when no location is assigned.
     */
    locationId: string | null;

    /**
     * Cvent appointment UUID returned after a successful POST to /appointment-events/{id}/appointments.
     * Null until the schedule has been written to Cvent.
     */
    cventAppointmentId: string | null;

    /**
     * ISO 8601 timestamp of the last admin edit to this meeting (slot, location, etc.).
     * Null if the meeting has never been manually modified since it was created or last pushed.
     */
    lastModifiedAt: string | null;

    /**
     * ISO 8601 timestamp of when this meeting was last pushed to Cvent.
     * Null if never pushed. A meeting is "modified since push" when
     * lastModifiedAt !== null && lastModifiedAt > lastPushedAt.
     */
    lastPushedAt: string | null;
}

/**
 * The per-attendee view of a full schedule.
 * Primary output shape for display and export.
 */
export interface AttendeeSchedule {
    /** References Attendee.id */
    attendeeId: string;

    /** Denormalized from Attendee.name for display convenience. */
    name: string;

    /** Denormalized from Attendee.company for display convenience. */
    company: string;

    /** Denormalized from Attendee.role for display convenience. */
    role: AttendeeRole;

    /** Confirmed meetings on Day 1, ordered by slot start time ascending. Empty array if none. */
    day1Meetings: ScheduledMeeting[];

    /** Confirmed meetings on Day 2, ordered by slot start time ascending. */
    day2Meetings: ScheduledMeeting[];
}

/**
 * The full output of a single scheduling engine run.
 * Returned by POST /api/scheduling/run and GET /api/scheduling/results.
 */
export interface SchedulerRunResult {
    /** Unique identifier for this run. */
    runId: string;

    /** ISO 8601 timestamp of when the run completed. */
    generatedAt: string;

    summary: {
        /** Total number of meetings scheduled across all passes. */
        totalMeetings: number;

        /** Number of attendees who received at least one meeting. */
        totalAttendees: number;

        /**
         * Meeting count broken down by pass number.
         * Useful for verifying that the algorithm is behaving as expected.
         */
        meetingsByPass: Record<number, number>;

        /**
         * Attendee IDs who received zero meetings after all passes completed.
         * May indicate data issues or scheduling conflicts that the engine could not resolve.
         */
        unmatchedAttendees: string[];
    };

    /** Full per-attendee schedule breakdown. */
    attendeeSchedules: AttendeeSchedule[];

    /** Flat list of all scheduled meetings across all attendees and passes. */
    allMeetings: ScheduledMeeting[];
}

/**
 * The one-time-code delivery channel a login contact was submitted through.
 * Shared by the login/verify routes, session payload, identity resolution,
 * and Twilio Verify wrapper so the union is defined in exactly one place.
 */
export type Channel = "sms" | "email";

/**
 * The resolved owner of a phone number or email address, produced by
 * lib/auth/identity.ts.
 *
 * - `source: "users"`  → `user` is the DB row; `attendee` is a thin Attendee
 *   shaped from that row.
 * - `source: "salesforce"` → `attendee` is the matched record; `user` is null.
 *
 * `attendee` is always populated so callers always have one shape to render.
 */
export type ResolvedIdentity = {
    /** Normalized phone or email the identity was resolved for. */
    contact: string;

    /** Which login channel `contact` was resolved through. */
    channel: Channel;

    /** Application role driving where the user lands. */
    role: "admin" | "user" | "sponsor";

    /** Where the identity came from. */
    source: "users" | "salesforce";

    /** Salesforce id used to attach records later, when known. */
    salesforceId: string | null;

    /** The DB row, when resolved from the users table. */
    user: User | null;

    /** The attendee record for this identity (always present). */
    attendee: Attendee;
};
