import { describe, test, expect } from 'vitest';
import { pairKey, computeMutualPairs, findMutualSlot, wouldViolateCompanyDiversity } from './helpers';
import type { Attendee, MeetingRequest, AttendeeSlot, ScheduledMeeting } from '@/types';

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
 * Helper to generate a fake attendee slot for testing.
 *
 * @param {string} slotId - Unique identifier for the slot.
 * @param {1 | 2} day - The event day this slot belongs to.
 * @param {string} startTime - ISO 8601 start time string.
 * @param {'available' | 'blocked'} status - Whether the slot is free or occupied.
 * @returns {AttendeeSlot} A slot object with the specified properties.
 */
function makeSlot(slotId: string, day: 1 | 2, startTime: string, status: 'available' | 'blocked' = 'available'): AttendeeSlot {
    return { slotId, day, startTime, endTime: startTime, status };
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
        cventContactId: '', salesforceId: '', name: '', email: '', phone: '',
        role: 'delegate', title: '', sponsorTier: null,
        profile: { annualRevenue: null, budgetaryResponsibility: null, areasOfSpecialization: [], industrySectors: [], plannedSpend: null, companySize: null, regionsOverseen: [], strategicPriorities: [] },
        scheduling: { slots: [], maxSameCompanyMeetings: null },
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
        day: 1, slotIdA: '', slotIdB: '', passNumber: 1,
        mutual: false, matchKind: 'sponsor_choice', rank: null,
        source: 'portal', location: null,
        startTime: null, endTime: null, cventAppointmentId: null,
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

describe('findMutualSlot', () => {
    test('returns null when both attendees have no slots', () => {
        expect(findMutualSlot([], [], 1)).toBeNull();
    });

    test('returns null when slots do not overlap', () => {
        const slotsA = [makeSlot('a-d1-01', 1, '09:00')];
        const slotsB = [makeSlot('b-d1-01', 1, '10:00')];
        expect(findMutualSlot(slotsA, slotsB, 1)).toBeNull();
    });

    test('returns null when the matching slot is on a different day', () => {
        const slotsA = [makeSlot('a-d1-01', 1, '09:00')];
        const slotsB = [makeSlot('b-d2-01', 2, '09:00')];
        expect(findMutualSlot(slotsA, slotsB, 1)).toBeNull();
    });

    test('returns null when the matching slot is blocked', () => {
        const slotsA = [makeSlot('a-d1-01', 1, '09:00')];
        const slotsB = [makeSlot('b-d1-01', 1, '09:00', 'blocked')];
        expect(findMutualSlot(slotsA, slotsB, 1)).toBeNull();
    });

    test('returns the matched slot pair when both attendees are available at the same time', () => {
        const slotA = makeSlot('a-d1-01', 1, '09:00');
        const slotB = makeSlot('b-d1-01', 1, '09:00');
        expect(findMutualSlot([slotA], [slotB], 1)).toEqual({ slotA, slotB });
    });

    test('returns the first overlapping slot when multiple are available', () => {
        const slotA1 = makeSlot('a-d1-01', 1, '09:00');
        const slotA2 = makeSlot('a-d1-02', 1, '10:00');
        const slotB1 = makeSlot('b-d1-01', 1, '09:00');
        const slotB2 = makeSlot('b-d1-02', 1, '10:00');
        expect(findMutualSlot([slotA1, slotA2], [slotB1, slotB2], 1)).toEqual({ slotA: slotA1, slotB: slotB1 });
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
