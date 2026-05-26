/**
 * Attendee role. Determines scheduling rules, day eligibility, and meeting caps.
 * - `delegate`: Event attendee; eligible for sponsor meetings on Day 1 and peer meetings on Day 2.
 * - `sponsor`: Paying sponsor; eligible for delegate meetings on Day 1 only.
 */
export type AttendeeRole = 'delegate' | 'sponsor';

/**
 * Sponsor package tier. Determines the sponsor's meeting cap in Pass 5.
 * - `diamond`: Highest tier; guaranteed 8 package meetings, cap raised to 10 in Pass 5.
 * - `standard`: All other tiers; guaranteed 5 package meetings, cap raised to 7 in Pass 5.
 * - `null`: Not applicable (delegates).
 */
export type SponsorTier = 'diamond' | 'standard' | null;

/**
 * Status of a single time slot in an attendee's schedule.
 * - `available`: The slot is free and can be assigned a meeting by the engine.
 * - `blocked`: The slot is already occupied by a session or existing appointment in Cvent.
 */
export type SlotStatus = 'available' | 'blocked';

/**
 * A single time slot in an attendee's schedule, sourced from Cvent's availability API.
 * The engine uses slots to find mutually available times when confirming a meeting pair.
 */
export interface AttendeeSlot {
	/** Unique identifier for this slot. Used to reference the slot on ScheduledMeeting. */
	slotId: string;

	/** The event day this slot belongs to. Day 1 = sponsor/delegate meetings; Day 2 = delegate/delegate only. */
	day: 1 | 2;

	/** ISO 8601 UTC start time of the slot, sourced from Cvent. Written to the Cvent appointment on output. */
	startTime: string;

	/** ISO 8601 UTC end time of the slot, sourced from Cvent. Written to the Cvent appointment on output. */
	endTime: string;

	/** Whether this slot is free or already occupied. The engine skips blocked slots entirely. */
	status: SlotStatus;
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
	annualRevenue: string | null;

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
	companySize: string | null;

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

	/** Existing scheduling constraints for this attendee. */
	scheduling: {
		/** All possible meeting slots for this attendee across both days sourced from Cvent's availability API. */
		slots: AttendeeSlot[];

		/**
		 * Maximum number of meetings this attendee can have with people from the same company.
		 * Null for sponsors because the rule does not apply to them (@todo need to confirm this).
		 */
		maxSameCompanyMeetings: number | null;
	};
}

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
 * startTime, endTime, and cventAppointmentId are null until the schedule is written to Cvent,
 * at which point slot times are mapped from AttendeeSlot and the Cvent appointment ID is populated.
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

	/** The slotId from attendeeA's slots array assigned to this meeting. */
	slotIdA: string;

	/** The slotId from attendeeB's slots array assigned to this meeting. */
	slotIdB: string;

	/**
	 * Which algorithm pass produced this meeting (1–7).
	 * Retained on output for auditing, spot-checking, and human review.
	 */
	passNumber: number;

	/**
	 * Whether both attendees requested each other.
	 * Computed by the engine at runtime and stored on the output for transparency.
	 */
	mutual: boolean;

	/**
	 * ISO 8601 UTC start time of the meeting.
	 * Null until the Cvent write step, at which point it is populated from the assigned AttendeeSlot.
	 */
	startTime: string | null;

	/**
	 * ISO 8601 UTC end time of the meeting.
	 * Null until the Cvent write step, at which point it is populated from the assigned AttendeeSlot.
	 */
	endTime: string | null;

	/**
	 * Cvent appointment UUID returned after a successful POST to /appointment-events/{id}/appointments.
	 * Null until the schedule has been written to Cvent.
	 */
	cventAppointmentId: string | null;
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
