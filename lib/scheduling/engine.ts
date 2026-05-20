import fs from 'fs';
import { Attendee, AttendeeRole, AttendeeSchedule, MeetingRequest, ScheduledMeeting, SponsorTier } from '@/types';

// ---------------------------------------------------------------------------
// CSV loaders
// ---------------------------------------------------------------------------

/**
 * Splits a raw CSV string into rows of trimmed cell values, skipping the header line.
 *
 * @param {string} raw - The full contents of a CSV file as a string.
 * @returns {string[][]} An array of rows, each row being an array of cell strings.
 */
function parseLines(raw: string): string[][] {

  // Remove the header row and split the rest into individual lines.
  const lines = raw.trim().split('\n').slice(1);

  // Split each line into cells by comma and trim whitespace from each value.
  return lines.map(line => line.split(',').map(v => v.trim()));
}

/**
 * Reads and parses `attendees.csv` at the given path into typed `Attendee` records.
 *
 * @param {string} filePath - Absolute path to the attendees CSV file.
 * @returns {Promise<Attendee[]>} Resolves to an array of parsed `Attendee` objects.
 */
export async function loadMockData(filePath: string): Promise<Attendee[]> {

  // Read the file from disk as a UTF-8 string.
  const raw = fs.readFileSync(filePath, 'utf-8');

  // Map each row to an Attendee object, casting string values to their correct types.
  return parseLines(raw).map(([id, name, role, company, sponsorTier, day1SlotCount, day2SlotCount]) => ({
    id,
    name,
    role: role as AttendeeRole,
    company,

    // The CSV stores null as the string "null" so convert it to an actual null.
    sponsorTier: sponsorTier === 'null' ? null : (sponsorTier as SponsorTier),

    // Parse slot counts from strings to integers
    day1SlotCount: parseInt(day1SlotCount, 10),
    day2SlotCount: parseInt(day2SlotCount, 10),
  }));
}

/**
 * Reads and parses `requests.csv` at the given path into typed `MeetingRequest` records.
 *
 * @param {string} filePath - Absolute path to the meeting requests CSV file.
 * @returns {Promise<MeetingRequest[]>} Resolves to an array of parsed `MeetingRequest` objects.
 */
export async function loadMockRequests(filePath: string): Promise<MeetingRequest[]> {

  // Read the file from disk as a UTF-8 string.
  const raw = fs.readFileSync(filePath, 'utf-8');

  // Map each row to a MeetingRequest object, parsing rank as an integer.
  return parseLines(raw).map(([requesterId, targetId, rank]) => ({
    requesterId,
    targetId,
    rank: parseInt(rank, 10),
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Produces a canonical, order-independent key for a pair of attendee IDs (e.g. `"d1|s2"`).
 *
 * @param {string} a - First attendee ID.
 * @param {string} b - Second attendee ID.
 * @returns {string} A stable key regardless of argument order.
 */
function pairKey(a: string, b: string): string {

  // Sort the two IDs alphabetically so the key is the same regardless of which is passed first.
  return [a, b].sort().join('|');
}

/**
 * Computes the set of attendee pairs where both parties requested each other.
 *
 * @param {MeetingRequest[]} requests - The full list of meeting requests.
 * @returns {Set<string>} A set of canonical pair keys (via `pairKey`) for mutual pairs.
 */
export function computeMutualPairs(requests: MeetingRequest[]): Set<string> {

  // Build a fast lookup set of every directed request as "requesterId->targetId".
  const requestSet = new Set(requests.map(r => `${r.requesterId}->${r.targetId}`));

  // Initialize an empty set to hold the canonical keys of mutual pairs.
  const mutual = new Set<string>();

  // For each request, check whether the reverse request also exists.
  for (const r of requests) {
    if (requestSet.has(`${r.targetId}->${r.requesterId}`)) {

      // Store the pair using the canonical key so duplicates are automatically deduplicated.
      mutual.add(pairKey(r.requesterId, r.targetId));
    }
  }

  // Return the set of mutual pair keys.
  return mutual;
}

/**
 * Checks whether scheduling a meeting between two attendees would exceed the same-company cap.
 *
 * @param {ScheduledMeeting[]} scheduledMeetings - All meetings scheduled so far.
 * @param {Map<string, Attendee>} attendees - Lookup map of all attendees by ID.
 * @param {string} attendeeId - The attendee whose existing schedule is being checked.
 * @param {string} candidateId - The prospective meeting partner.
 * @param {number} maxSameCompany - Maximum allowed meetings with attendees from the same company.
 * @returns {boolean} `true` if adding this meeting would violate the diversity rule.
 */
export function wouldViolateCompanyDiversity(
  scheduledMeetings: ScheduledMeeting[],
  attendees: Map<string, Attendee>,
  attendeeId: string,
  candidateId: string,
  maxSameCompany: number
): boolean {

  // Look up the company of the person we're considering scheduling.
  const candidateCompany = attendees.get(candidateId)?.company;

  // If the candidate doesn't exist in the map, allow the meeting.
  if (!candidateCompany) return false;

  // Count how many of the attendee's existing meetings are with people from the same company.
  const sameCompanyCount = scheduledMeetings.filter(m => {
    const isInvolved = m.attendeeA === attendeeId || m.attendeeB === attendeeId;

    // Skip meetings this attendee isn't part of.
    if (!isInvolved) return false;

    // Determine which participant is the other person in the meeting.
    const otherId = m.attendeeA === attendeeId ? m.attendeeB : m.attendeeA;

    // Check if the other person's company matches the candidate's company.
    return attendees.get(otherId)?.company === candidateCompany;
  }).length;

  // Check to see if adding this meeting would violate the max number of same-company meetings allowed.
  return sameCompanyCount >= maxSameCompany;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

interface PassConfig {
  passNumber: number;
  day: 1 | 2;
  delegateCap: number;
  sponsorCap: (tier: SponsorTier) => number;
  filter: (
    requester: Attendee,
    target: Attendee,
    rank: number,
    isMutual: boolean
  ) => boolean;
}

// Cumulative meeting caps for each sponsor tier at pass 5.
const SPONSOR_CAPS_PASS5: Record<string, number> = { diamond: 10, standard: 8 };

// Defines the seven passes of the scheduling algorithm with their specific rules and caps.
const PASSES: PassConfig[] = [
  {
    passNumber: 1,
    day: 1,
    delegateCap: 2,
    sponsorCap: () => 3,
    filter: (req, tgt, _rank, mutual) =>
      mutual && ((req.role === 'sponsor' && tgt.role === 'delegate') || (req.role === 'delegate' && tgt.role === 'sponsor')),
  },
  {
    passNumber: 2,
    day: 1,
    delegateCap: 3,
    sponsorCap: () => 4,
    filter: (req, tgt, rank, _mutual) =>
      req.role === 'sponsor' && tgt.role === 'delegate' && rank >= 4,
  },
  {
    passNumber: 3,
    day: 1,
    delegateCap: 4,
    sponsorCap: () => 6,
    filter: (req, tgt, rank, _mutual) =>
      req.role === 'delegate' && tgt.role === 'sponsor' && rank >= 4,
  },
  {
    passNumber: 4,
    day: 1,
    delegateCap: 5,
    sponsorCap: () => 8,
    filter: (req, tgt, _rank, mutual) =>
      mutual && ((req.role === 'sponsor' && tgt.role === 'delegate') || (req.role === 'delegate' && tgt.role === 'sponsor')),
  },
  {
    passNumber: 5,
    day: 1,
    delegateCap: 7,
    sponsorCap: (tier) => (tier ? SPONSOR_CAPS_PASS5[tier] ?? 8 : 8),
    filter: (req, tgt, _rank, _mutual) =>
      req.role === 'sponsor' && tgt.role === 'delegate',
  },
  {
    passNumber: 6,
    day: 2,
    delegateCap: 2,
    sponsorCap: () => 0,
    filter: (req, tgt, _rank, mutual) =>
      mutual && req.role === 'delegate' && tgt.role === 'delegate',
  },
  {
    passNumber: 7,
    day: 2,
    delegateCap: 2,
    sponsorCap: () => 0,
    filter: (req, tgt, _rank, _mutual) =>
      req.role === 'delegate' && tgt.role === 'delegate',
  },
];

/**
 * Returns the cumulative meeting cap for an attendee under a given pass configuration.
 *
 * @param {Attendee} attendee - The attendee whose cap is being looked up.
 * @param {PassConfig} pass - The current pass configuration.
 * @returns {number} The maximum total meetings allowed for this attendee by the end of this pass.
 */
function getCap(attendee: Attendee, pass: PassConfig): number {

  // Sponsors and delegates have separate cap functions per pass.
  return attendee.role === 'sponsor'
    ? pass.sponsorCap(attendee.sponsorTier)
    : pass.delegateCap;
}

/**
 * Runs the full multi-pass scheduling algorithm against a set of attendees and requests.
 *
 * Meetings are scheduled across seven passes in priority order. Caps are cumulative —
 * each pass raises the ceiling without resetting counts. Business rules (no duplicates,
 * no self-meetings, company diversity) are enforced on every candidate before scheduling.
 *
 * @param {Attendee[]} attendees - All attendees to schedule meetings for.
 * @param {MeetingRequest[]} requests - All submitted meeting requests.
 * @returns {Promise<{ schedule: ScheduledMeeting[]; attendeeSchedules: AttendeeSchedule[] }>}
 *   Resolves to the flat list of all scheduled meetings and a per-attendee breakdown.
 */
export async function runScheduler(
  attendees: Attendee[],
  requests: MeetingRequest[]
): Promise<{ schedule: ScheduledMeeting[]; attendeeSchedules: AttendeeSchedule[] }> {

  // Index attendees by ID for O(1) lookup throughout the algorithm.
  const attendeeMap = new Map(attendees.map(a => [a.id, a]));

  // Pre-compute all mutual pairs once so each pass can check mutuality cheaply.
  const mutualPairs = computeMutualPairs(requests);

  // Initialize a set to track which pairs have already been scheduled to prevent duplicates.
  const scheduled = new Set<string>();

  // Initialize sets of cumulative meeting counts per attendee across all passes.
  const counts = new Map<string, number>(attendees.map(a => [a.id, 0]));

  // Track how many slots each attendee has used per day for slotIndex assignment.
  const slotCounters = new Map<string, { 1: number; 2: number }>(
    attendees.map(a => [a.id, { 1: 0, 2: 0 }])
  );

  // Initialize the master list of all scheduled meetings.
  const allMeetings: ScheduledMeeting[] = [];

  // Loop through each pass in order, applying its specific filters and caps to schedule meetings.
  for (const pass of PASSES) {

    // Collect every request that is eligible to be scheduled in this pass.
    const candidates: Array<{ req: MeetingRequest; isMutual: boolean }> = [];

    // Loop through all requests to find candidates for this pass based on the pass's filter function and mutuality.
    for (const req of requests) {

      // Get the requester and target Attendee objects for this request.
      const requester = attendeeMap.get(req.requesterId);
      const target = attendeeMap.get(req.targetId);

      // Skip if either party isn't in the attendee list.
      if (!requester || !target) continue;

      // Generate the canonical pair key for this request to check if it's already scheduled.
      const key = pairKey(req.requesterId, req.targetId);

      // Skip pairs already scheduled in a previous pass.
      if (scheduled.has(key)) continue;

      // Skip self-requests.
      if (req.requesterId === req.targetId) continue;

      // Check if this pair is mutual.
      const isMutual = mutualPairs.has(key);

      // Apply this pass's eligibility filter.
      if (!pass.filter(requester, target, req.rank, isMutual)) continue;

      // If we passed all the checks, this request is a candidate for scheduling in this pass.
      candidates.push({ req, isMutual });
    }

    // Sort candidates: highest rank first, mutual requests win ties, then alphabetically by target ID.
    candidates.sort((a, b) => {
      if (b.req.rank !== a.req.rank) return b.req.rank - a.req.rank;
      if (a.isMutual !== b.isMutual) return a.isMutual ? -1 : 1;
      return a.req.targetId.localeCompare(b.req.targetId);
    });

    // Loop through the sorted candidates and schedule them if they still meet the criteria.
    for (const { req } of candidates) {

      // Re-generate the pair key for this request to check if it's already scheduled.
      const key = pairKey(req.requesterId, req.targetId);

      // Check if a higher-priority candidate in this same pass already claimed this pair.
      if (scheduled.has(key)) continue;

      // Get the requester and target Attendee objects again for this request.
      const requester = attendeeMap.get(req.requesterId)!;
      const target = attendeeMap.get(req.targetId)!;

      // Check the cumulative meeting counts and caps for both attendees.
      const requesterCount = counts.get(req.requesterId) ?? 0;
      const targetCount = counts.get(req.targetId) ?? 0;
      const requesterCap = getCap(requester, pass);
      const targetCap = getCap(target, pass);

      // Skip if either attendee has hit their cumulative cap for this pass.
      if (requesterCount >= requesterCap) continue;
      if (targetCount >= targetCap) continue;

      // Skip if this meeting would give either attendee too many meetings with the same company.
      if (wouldViolateCompanyDiversity(allMeetings, attendeeMap, req.requesterId, req.targetId, 2)) continue;
      if (wouldViolateCompanyDiversity(allMeetings, attendeeMap, req.targetId, req.requesterId, 2)) continue;

      // Assign the next available slot index for this day, using the later of the two attendees' counters.
      const day = pass.day;
      const aSlots = slotCounters.get(req.requesterId)!;
      const bSlots = slotCounters.get(req.targetId)!;
      const slotIndex = Math.max(aSlots[day], bSlots[day]);

      // Create the ScheduledMeeting record for this meeting.
      const meeting: ScheduledMeeting = {
        attendeeA: req.requesterId,
        attendeeB: req.targetId,
        day,
        slotIndex,
        passNumber: pass.passNumber,
      };

      // Add this meeting to the master schedule.
      allMeetings.push(meeting);

      // Mark the pair as scheduled so no later pass can schedule them again.
      scheduled.add(key);

      // Increment both attendees' cumulative meeting counts.
      counts.set(req.requesterId, requesterCount + 1);
      counts.set(req.targetId, targetCount + 1);

      // Advance both attendees' slot counters for this day.
      aSlots[day] = slotIndex + 1;
      bSlots[day] = slotIndex + 1;
    }
  }

  // Build a per-attendee view of the schedule by filtering the full meeting list.
  const attendeeSchedules: AttendeeSchedule[] = attendees.map(a => ({
    attendeeId: a.id,
    name: a.name,
    company: a.company,
    role: a.role,
    day1Meetings: allMeetings.filter(m => m.day === 1 && (m.attendeeA === a.id || m.attendeeB === a.id)),
    day2Meetings: allMeetings.filter(m => m.day === 2 && (m.attendeeA === a.id || m.attendeeB === a.id)),
  }));

  // Return both the flat list of all scheduled meetings and the per-attendee schedules.
  return { schedule: allMeetings, attendeeSchedules };
}
