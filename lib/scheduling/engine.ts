import fs from 'fs';
import path from 'path';
import { Attendee, MeetingRequest, ScheduledMeeting } from '@/types';

export async function loadMockData(filePath: string): Promise<Attendee[]> {
  // TODO (Peter): Parse the CSV at filePath and return typed Attendee records.
  // Expected CSV columns: id, name, role, company, preferences (semicolon-separated), meetingCap
  const resolved = path.resolve(filePath);
  void fs.existsSync(resolved);
  return [];
}

export async function runScheduler(
  attendees: Attendee[],
  requests: MeetingRequest[]
): Promise<ScheduledMeeting[]> {
  // TODO (Peter): Implement multi-pass scheduling logic.
  // Pass 1: mutual requests, Pass 2: one-way requests, etc.
  void attendees;
  void requests;
  return [];
}
