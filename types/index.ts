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
 *
 * For DELEGATES, all but `industrySectors` come from the event's intake form,
 * landing on CventEvents__Attendee__c (see lib/salesforce/client.ts). Salesforce
 * stores every one of those answers as free text — semicolon-delimited where the
 * form question allowed multiple choices — so the multi-answer fields are
 * modeled as string[] and split on ingest by
 * `splitPicklist` (lib/attendees/formatProfile.ts).
 *
 * Because the values are form text rather than a fixed picklist, nothing in the
 * app hardcodes the possible values: the catalog's filter options and sort
 * ordering are both derived from the loaded delegates (see
 * app/components/catalogFormat.ts).
 *
 * SPONSORS have no intake form, so only the Account-derived fields
 * (annualRevenue, companySize, industrySectors) are ever populated for them —
 * and nothing in the UI reads a sponsor's profile today.
 */
export interface AttendeeProfile {
    /**
     * "What is your company's annual revenue?"
     * Delegates: CventEvents_NP_Annual_Revenue__c.
     * Sponsors: bucketed from Account.AnnualRevenue.
     */
    annualRevenue: string | null;

    /**
     * "Your personal budgetary responsibility."
     * Delegates: CventEvents_NP_Budget_Responsibility__c. Null for sponsors.
     */
    budgetaryResponsibility: string | null;

    /**
     * "How many employees does your company have?"
     * Delegates: CventEvents_NP_Company_Size__c.
     * Sponsors: bucketed from Account.NumberOfEmployees.
     */
    companySize: string | null;

    /**
     * The industry sector(s) the attendee's company operates in.
     * Sourced from Account.Industry_Category__c for both roles.
     * Example values: ['technology', 'healthcare', 'financial services']
     */
    industrySectors: string[];

    /**
     * "Pick the 3–4 topics closest to your current focus."
     * Delegates: CventEvents_NP_Current_Focus_Topics__c. Surfaced in the UI as
     * "Planned Interest Areas". Empty for sponsors.
     */
    interestAreas: string[];

    /**
     * "Where is your organization on its transformation journey in this area?"
     * Delegates: CventEvents_NP_Transformation_Stage__c. Surfaced in the UI as
     * "Progress on Interest Areas". Null for sponsors.
     */
    transformationStage: string | null;

    /**
     * "What systems and platforms are you using today?"
     * Delegates: CventEvents_NP_Systems_and_Platforms__c. Empty for sponsors.
     */
    systemsAndPlatforms: string[];

    /**
     * "For the pre-arranged one-to-one meetings, which of the following areas
     * are you interested in?"
     * Delegates: CventEvents_NP_One_to_One_Interests__c. Surfaced in the UI as
     * "Meeting Interests". Empty for sponsors.
     */
    meetingInterests: string[];

    /**
     * "If you could fund one initiative over the next 24 months, which would
     * you prioritize?"
     * Delegates: CventEvents_NP_Initiative_Priority__c. Null for sponsors.
     */
    priorityInitiative: string | null;
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

    /**
     * Salesforce Account id of the attendee's employer (company).
     *
     * For SPONSORS this is the scheduling/storage "party id": all reps of a
     * company share it, so requests and meetings are keyed by company rather
     * than by the individual rep. For delegates it is informational only —
     * delegates still schedule by their own salesforceId. See
     * lib/attendees/companies.ts (`partyId`). Empty string when unknown.
     */
    accountId: string;

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
    /** Company Salesforce Account id — the sponsor-side party id. */
    accountId: string;
    /** All reps belonging to the company (each hosts the company's Cvent appointments). */
    reps: Attendee[];
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
