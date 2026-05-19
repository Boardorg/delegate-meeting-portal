export interface Attendee {
  id: string;
  name: string;
  role: string;
  company: string;
  preferences: string[];
  meetingCap: number;
}

export interface MeetingRequest {
  requesterId: string;
  targetId: string;
  mutual: boolean;
  passNumber: number;
}

export interface ScheduledMeeting {
  attendeeA: string;
  attendeeB: string;
  timeSlot: string;
  day: string;
}
