import type { Attendee, Timeslot } from "@/types";

// ---------------------------------------------------------------------------
// Splitting a company's reps across its same-time meetings.
//
// Cvent rejects a host who is already in another appointment at that time.
// So when a sponsor company has more than one meeting at a start time, each
// rep hosts only one of them.
// A rep already hosting a Cvent appointment at that time is not free.
// Existing appointments are never changed to free up a rep.
//
// Pure (no network or DB) so push can be tested without Cvent. Lives outside
// lib/cvent/push.ts, which is server-only.
// ---------------------------------------------------------------------------

/** The fields of a meeting row the split reads. */
export type SplitMeeting = {
    id: string;
    attendeeA: string;
    timeslotId: string;
};

/**
 * The reps who are free to host at a time, so not already hosting a Cvent appointment then.
 *
 * @param {Attendee[]} reps - The company's reps who can host.
 * @param {ReadonlySet<string>} busyHostIds - Contact ids already hosting a Cvent appointment at that time.
 * @returns {Attendee[]} The free reps.
 */
export function freeReps(
    reps: Attendee[],
    busyHostIds: ReadonlySet<string>,
): Attendee[] {
    return reps.filter((r) => !busyHostIds.has(r.cventContactId));
}

/**
 * Whether two meetings are at the same time.
 * Meetings in the same timeslot always are.
 * Otherwise both start times must be known and equal.
 * Cvent stops listing a slot once it is full, so a pushed meeting's slot may be unknown.
 *
 * @param {SplitMeeting} a - One meeting.
 * @param {SplitMeeting} b - The other meeting.
 * @param {Map<string, Pick<Timeslot, "startTime">>} timeslotById - The event's timeslots.
 * @returns {boolean} True when they start at the same moment.
 */
export function sameMeetingTime(
    a: SplitMeeting,
    b: SplitMeeting,
    timeslotById: Map<string, Pick<Timeslot, "startTime">>,
): boolean {
    if (a.timeslotId === b.timeslotId) return true;
    const sa = timeslotById.get(a.timeslotId)?.startTime;
    const sb = timeslotById.get(b.timeslotId)?.startTime;
    if (!sa || !sb) return false;
    const ta = new Date(sa).getTime();
    const tb = new Date(sb).getTime();
    return !Number.isNaN(ta) && ta === tb;
}

/**
 * The ids of a company's meetings at the same time as one meeting, including that meeting.
 * Every meeting the caller passes counts, pushed or not, so push gives the same answer each run.
 *
 * @param {SplitMeeting} meeting - The meeting being pushed.
 * @param {SplitMeeting[]} companyMeetings - The event's portal meetings. Other companies' meetings are ignored.
 * @param {Map<string, Pick<Timeslot, "startTime">>} timeslotById - The event's timeslots.
 * @param {(m: SplitMeeting) => boolean} [include] - Which other meetings take part, such as only those still to push. Defaults to all.
 * @returns {string[]} The meeting ids at that time, sorted.
 */
export function sameTimeMeetingIds<M extends SplitMeeting>(
    meeting: M,
    companyMeetings: M[],
    timeslotById: Map<string, Pick<Timeslot, "startTime">>,
    include: (m: M) => boolean = () => true,
): string[] {
    const ids = new Set<string>([meeting.id]);
    for (const m of companyMeetings) {
        if (m.attendeeA !== meeting.attendeeA) continue;
        if (m.id !== meeting.id && !include(m)) continue;
        if (sameMeetingTime(meeting, m, timeslotById)) ids.add(m.id);
    }
    return [...ids].sort();
}

/**
 * Picks the hosts for one of a company's meetings.
 * With one meeting at the time, every rep who can host is a host.
 * With more, the meetings are ordered by id and the reps by Salesforce id.
 * The reps are then dealt out in turn, so no rep hosts two meetings at once.
 * Each meeting gets at least one rep when there are at least as many reps as meetings.
 * A meeting can get none when there are more meetings than reps.
 *
 * @param {Attendee[]} reps - The company's reps who can host.
 * @param {string} meetingId - The meeting to pick hosts for.
 * @param {string[]} meetingIdsAtTime - Every one of the company's meeting ids at that time, including this one.
 * @returns {string[]} The Cvent contact ids of this meeting's hosts.
 */
export function hostContactIdsForMeeting(
    reps: Attendee[],
    meetingId: string,
    meetingIdsAtTime: string[],
): string[] {
    const sortedReps = [...reps].sort((a, b) =>
        a.salesforceId.localeCompare(b.salesforceId),
    );
    const meetings = [...new Set([...meetingIdsAtTime, meetingId])].sort();
    if (meetings.length <= 1) return sortedReps.map((r) => r.cventContactId);
    const index = meetings.indexOf(meetingId);
    return sortedReps
        .filter((_, i) => i % meetings.length === index)
        .map((r) => r.cventContactId);
}
