export type AttendeeRole = 'delegate' | 'sponsor';

export type SponsorTier = 'diamond' | 'standard' | null;

export interface Attendee {
	id: string;
	name: string;
	role: AttendeeRole;
	company: string;
	sponsorTier: SponsorTier;
	day1SlotCount: number;
	day2SlotCount: number;
}

export interface MeetingRequest {
	requesterId: string;
	targetId: string;
	rank: number; // Lower rank means higher preference.
}

export interface ScheduledMeeting {
	attendeeA: string;
	attendeeB: string;
	day: 1 | 2;
	slotIndex: number; // 0-based index for the time slot.
	passNumber: number; // 1-based index indicating which pass iteration generated this meeting.
}

export interface AttendeeSchedule {
	attendeeId: string;
	name: string;
	company: string;
	role: AttendeeRole;
	day1Meetings: ScheduledMeeting[];
	day2Meetings: ScheduledMeeting[];
}
