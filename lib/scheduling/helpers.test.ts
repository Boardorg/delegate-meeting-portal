import { describe, test, expect } from 'vitest';
import { pairKey, computeMutualPairs, findAvailableTimeslot, wouldViolateCompanyDiversity } from './helpers';
import type { Attendee, MeetingRequest, Timeslot, ScheduledMeeting } from '@/types';

// ---------------------------------------------------------------------------
// Helpers for generating test data
// ---------------------------------------------------------------------------

/**
 * Helper to generate a fake meeting request for testing.
 *
 * @param {string} requesterId - The ID of the attendee making the request.
 * @param {string} targetId - The ID of the attendee being requested.
 * @returns {MeetingRequest} A meeting request object with the specified requester and target.
 */
function makeRequest(requesterId: string, targetId: string): MeetingRequest {
    return { id: `${requesterId}-${targetId}`, requesterId, targetId, rank: 3 };
}

/**
 * Helper to generate a fake event-global timeslot for testing.
 *
 * @param {string} id - Unique identifier for the timeslot.
 * @param {1 | 2} day - The event day this timeslot belongs to.
 * @param {string} startTime - Start time string (treated opaquely).
 * @param {number} [capacity=1] - How many meetings may book this timeslot.
 * @returns {Timeslot} A timeslot object with the specified properties.
 */
function makeTimeslot(id: string, day: 1 | 2, startTime: string, capacity = 1): Timeslot {
    return { id, day, startTime, endTime: startTime, capacity, locationId: null };
}

/** Builds the remaining-capacity map findAvailableTimeslot expects. */
function remainingOf(timeslots: Timeslot[]): Map<string, number> {
    return new Map(timeslots.map((t) => [t.id, t.capacity]));
}

/**
 * Helper to generate a minimal fake attendee for testing.
 *
 * @param {string} id - The attendee's unique ID.
 * @param {string} company - The attendee's company name.
 * @returns {Attendee} A minimal attendee object with the specified ID and company.
 */
function makeAttendee(id: string, company: string): Attendee {
    return {
        id, company,
        cventContactId: '', salesforceId: id, name: '', email: '', phone: '',
        role: 'delegate', title: '', sponsorTier: null,
        profile: { annualRevenue: null, budgetaryResponsibility: null, areasOfSpecialization: [], industrySectors: [], plannedSpend: null, companySize: null, regionsOverseen: [], strategicPriorities: [] },
        scheduling: { maxSameCompanyMeetings: null },
    };
}

/**
 * Helper to generate a minimal fake scheduled meeting for testing.
 *
 * @param {string} attendeeA - The ID of the first meeting participant.
 * @param {string} attendeeB - The ID of the second meeting participant.
 * @returns {ScheduledMeeting} A minimal scheduled meeting between the two attendees.
 */
function makeMeeting(attendeeA: string, attendeeB: string): ScheduledMeeting {
    return {
        id: `${attendeeA}-${attendeeB}`, attendeeA, attendeeB,
        day: 1, timeslotId: '', passNumber: 1,
        mutual: false, matchKind: 'sponsor_choice', rank: null,
        source: 'portal', locationId: null, cventAppointmentId: null,
        lastModifiedAt: null, lastPushedAt: null,
    };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('pairKey', () => {
    test('joins two IDs with a pipe', () => {
        expect(pairKey('d1', 's2')).toBe('d1|s2');
    });

    test('returns the same key regardless of argument order', () => {
        expect(pairKey('d1', 's2')).toBe(pairKey('s2', 'd1'));
    });
});

describe('computeMutualPairs', () => {
    test('returns empty set when there are no requests', () => {
        expect(computeMutualPairs([])).toEqual(new Set());
    });

    test('returns empty set when no requests are mutual', () => {
        const requests = [makeRequest('d1', 's1'), makeRequest('d2', 's2')];
        expect(computeMutualPairs(requests)).toEqual(new Set());
    });

    test('identifies a mutual pair when both parties requested each other', () => {
        const requests = [makeRequest('d1', 's1'), makeRequest('s1', 'd1')];
        expect(computeMutualPairs(requests)).toEqual(new Set(['d1|s1']));
    });

    test('handles multiple mutual pairs independently', () => {
        const requests = [
            makeRequest('d1', 's1'), makeRequest('s1', 'd1'),
            makeRequest('d2', 's2'), makeRequest('s2', 'd2'),
        ];
        expect(computeMutualPairs(requests)).toEqual(new Set(['d1|s1', 'd2|s2']));
    });
});

describe('findAvailableTimeslot', () => {
    const empty = new Set<string>();

    test('returns null when there are no timeslots', () => {
        expect(findAvailableTimeslot([], 1, empty, empty, new Map())).toBeNull();
    });

    test('returns null when the only timeslot is on a different day', () => {
        const timeslots = [makeTimeslot('ts-1', 2, '09:00')];
        expect(findAvailableTimeslot(timeslots, 1, new Set(), new Set(), remainingOf(timeslots))).toBeNull();
    });

    test('returns null when the timeslot has no remaining capacity', () => {
        const timeslots = [makeTimeslot('ts-1', 1, '09:00')];
        const remaining = new Map([['ts-1', 0]]);
        expect(findAvailableTimeslot(timeslots, 1, new Set(), new Set(), remaining)).toBeNull();
    });

    test('returns null when one attendee is already busy at that start time', () => {
        const timeslots = [makeTimeslot('ts-1', 1, '09:00')];
        const busyA = new Set(['09:00']);
        expect(findAvailableTimeslot(timeslots, 1, busyA, new Set(), remainingOf(timeslots))).toBeNull();
    });

    test('returns the timeslot when both attendees are free and capacity remains', () => {
        const ts = makeTimeslot('ts-1', 1, '09:00');
        expect(findAvailableTimeslot([ts], 1, new Set(), new Set(), remainingOf([ts]))).toEqual(ts);
    });

    test('returns the first usable timeslot when several exist', () => {
        const busy = new Set(['09:00']); // both busy at 09:00, so the 10:00 slot wins
        const ts1 = makeTimeslot('ts-1', 1, '09:00');
        const ts2 = makeTimeslot('ts-2', 1, '10:00');
        expect(findAvailableTimeslot([ts1, ts2], 1, busy, busy, remainingOf([ts1, ts2]))).toEqual(ts2);
    });
});

describe('wouldViolateCompanyDiversity', () => {
    test('returns false when the candidate is not in the attendee map', () => {
        const attendees = new Map([['d1', makeAttendee('d1', 'Acme')]]);
        expect(wouldViolateCompanyDiversity([], attendees, 'd1', 'unknown', 2)).toBe(false);
    });

    test('returns false when the attendee has no existing meetings', () => {
        const attendees = new Map([
            ['d1', makeAttendee('d1', 'Acme')],
            ['s1', makeAttendee('s1', 'Globex')],
        ]);
        expect(wouldViolateCompanyDiversity([], attendees, 'd1', 's1', 2)).toBe(false);
    });

    test('returns false when same-company meetings are below the cap', () => {
        const attendees = new Map([
            ['d1', makeAttendee('d1', 'Acme')],
            ['s1', makeAttendee('s1', 'Globex')],
            ['s2', makeAttendee('s2', 'Globex')],
        ]);
        const meetings = [makeMeeting('d1', 's1')];
        expect(wouldViolateCompanyDiversity(meetings, attendees, 'd1', 's2', 2)).toBe(false);
    });

    test('returns true when same-company meetings equal the cap', () => {
        const attendees = new Map([
            ['d1', makeAttendee('d1', 'Acme')],
            ['s1', makeAttendee('s1', 'Globex')],
            ['s2', makeAttendee('s2', 'Globex')],
        ]);
        const meetings = [makeMeeting('d1', 's1'), makeMeeting('d1', 's2')];
        expect(wouldViolateCompanyDiversity(meetings, attendees, 'd1', 's2', 2)).toBe(true);
    });

    test('counts meetings correctly when the attendee appears as either participant', () => {
        const attendees = new Map([
            ['d1', makeAttendee('d1', 'Acme')],
            ['s1', makeAttendee('s1', 'Globex')],
            ['s2', makeAttendee('s2', 'Globex')],
        ]);
        const meetings = [makeMeeting('s1', 'd1')];
        expect(wouldViolateCompanyDiversity(meetings, attendees, 'd1', 's2', 1)).toBe(true);
    });
});
