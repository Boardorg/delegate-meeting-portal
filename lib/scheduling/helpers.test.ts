import { describe, test, expect } from 'vitest';
import { pairKey, computeMutualPairs, findAvailableTimeslot, withDelegatePreferences, wouldViolateCompanyDiversity, DELEGATE_PREFERENCE_RANK } from './helpers';
import { emptyProfile } from '@/lib/attendees/formatProfile';
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
    return { id, day, startTime, endTime: startTime, capacity, locationId: null, appointmentTypeId: 'type-1' };
}

/** Builds the remaining-capacity map findAvailableTimeslot expects. */
function remainingOf(timeslots: Timeslot[]): Map<string, number> {
    return new Map(timeslots.map((t) => [t.id, t.capacity]));
}

/**
 * Minimal scheduling-entity stub carrying just the companyKey the diversity
 * check reads. wouldViolateCompanyDiversity compares parties by companyKey
 * (the account id), so two entities sharing a key model reps of one company.
 *
 * @param {string} companyKey - The party's company key (account id).
 * @returns {{ companyKey: string }} The stub entity.
 */
function ent(companyKey: string): { companyKey: string } {
    return { companyKey };
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
    test('returns false when the candidate is not in the entity map', () => {
        const entities = new Map([['d1', ent('acct-acme')]]);
        expect(wouldViolateCompanyDiversity([], entities, 'd1', 'unknown', 2)).toBe(false);
    });

    test('returns false when the attendee has no existing meetings', () => {
        const entities = new Map([
            ['d1', ent('acct-acme')],
            ['s1', ent('acct-globex')],
        ]);
        expect(wouldViolateCompanyDiversity([], entities, 'd1', 's1', 2)).toBe(false);
    });

    test('returns false when same-company meetings are below the cap', () => {
        // s1 and s2 share a company key (reps of one company / same account).
        const entities = new Map([
            ['d1', ent('acct-acme')],
            ['s1', ent('acct-globex')],
            ['s2', ent('acct-globex')],
        ]);
        const meetings = [makeMeeting('d1', 's1')];
        expect(wouldViolateCompanyDiversity(meetings, entities, 'd1', 's2', 2)).toBe(false);
    });

    test('returns true when same-company meetings equal the cap', () => {
        const entities = new Map([
            ['d1', ent('acct-acme')],
            ['s1', ent('acct-globex')],
            ['s2', ent('acct-globex')],
        ]);
        const meetings = [makeMeeting('d1', 's1'), makeMeeting('d1', 's2')];
        expect(wouldViolateCompanyDiversity(meetings, entities, 'd1', 's2', 2)).toBe(true);
    });

    test('counts meetings correctly when the attendee appears as either participant', () => {
        const entities = new Map([
            ['d1', ent('acct-acme')],
            ['s1', ent('acct-globex')],
            ['s2', ent('acct-globex')],
        ]);
        const meetings = [makeMeeting('s1', 'd1')];
        expect(wouldViolateCompanyDiversity(meetings, entities, 'd1', 's2', 1)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// withDelegatePreferences
//
// Delegates express who they want to meet on the event's intake form, not in
// the portal. Folding those answers in as delegate→sponsor requests is what
// makes the existing mutual / delegate-choice passes see the delegate side at
// all, so these cases pin the derivation and its guards.
// ---------------------------------------------------------------------------

/**
 * Builds an attendee for the preference tests.
 *
 * @param {string} id - Salesforce id (also the delegate's party id).
 * @param {'sponsor' | 'delegate'} role - The attendee's role.
 * @param {string} accountId - Employer account id; the party id for sponsors.
 * @param {string[]} requestedSponsorAccountIds - Intake-form answers.
 * @returns {Attendee} The attendee.
 */
function makeAttendee(
    id: string,
    role: 'sponsor' | 'delegate',
    accountId: string,
    requestedSponsorAccountIds: string[] = [],
): Attendee {
    return {
        id,
        cventContactId: '',
        salesforceId: id,
        accountId,
        name: id,
        email: '',
        phone: '',
        role,
        company: accountId,
        title: '',
        sponsorTier: role === 'sponsor' ? 'standard' : null,
        profile: emptyProfile(),
        scheduling: {
            maxSameCompanyMeetings: role === 'sponsor' ? null : 2,
            requestedSponsorAccountIds,
        },
    };
}

describe('withDelegatePreferences', () => {
    const sponsorRep = makeAttendee('rep-1', 'sponsor', 'acct-A');
    const otherSponsor = makeAttendee('rep-2', 'sponsor', 'acct-B');

    test('turns each intake answer into a delegate → sponsor request', () => {
        const delegate = makeAttendee('del-1', 'delegate', 'acct-D', [
            'acct-A',
            'acct-B',
        ]);
        const out = withDelegatePreferences([], [sponsorRep, otherSponsor, delegate]);

        expect(out).toHaveLength(2);
        expect(out.map((r) => [r.requesterId, r.targetId])).toEqual([
            ['del-1', 'acct-A'],
            ['del-1', 'acct-B'],
        ]);
        // Targets are company account ids — the party id the engine keys by —
        // not an individual rep's salesforceId.
        expect(out.map((r) => r.targetId)).not.toContain('rep-1');
    });

    test('ranks derived requests at the engine\'s high-interest threshold', () => {
        const delegate = makeAttendee('del-1', 'delegate', 'acct-D', ['acct-A']);
        const [derived] = withDelegatePreferences([], [sponsorRep, delegate]);
        // Pass 3 gates delegate→sponsor candidates on rank >= 4.
        expect(derived.rank).toBe(DELEGATE_PREFERENCE_RANK);
        expect(derived.rank).toBeGreaterThanOrEqual(4);
    });

    test('makes a pair mutual when the sponsor also requested the delegate', () => {
        const delegate = makeAttendee('del-1', 'delegate', 'acct-D', ['acct-A']);
        const sponsorRequest: MeetingRequest = {
            id: '1',
            requesterId: 'acct-A',
            targetId: 'del-1',
            rank: 5,
        };
        const merged = withDelegatePreferences(
            [sponsorRequest],
            [sponsorRep, delegate],
        );
        expect(computeMutualPairs(merged)).toContain(pairKey('acct-A', 'del-1'));
    });

    test('leaves an unreciprocated preference as a one-sided request', () => {
        const delegate = makeAttendee('del-1', 'delegate', 'acct-D', ['acct-A']);
        const merged = withDelegatePreferences([], [sponsorRep, delegate]);
        expect(computeMutualPairs(merged).size).toBe(0);
        expect(merged).toHaveLength(1);
    });

    test('ignores an account id that is not a sponsor at this event', () => {
        // A stale or foreign id would otherwise surface in the run report as
        // "not an attendee".
        const delegate = makeAttendee('del-1', 'delegate', 'acct-D', [
            'acct-A',
            'acct-GONE',
        ]);
        const out = withDelegatePreferences([], [sponsorRep, delegate]);
        expect(out.map((r) => r.targetId)).toEqual(['acct-A']);
    });

    test('keeps the submitted request when a portal request already covers the pair', () => {
        const delegate = makeAttendee('del-1', 'delegate', 'acct-D', ['acct-A']);
        const submitted: MeetingRequest = {
            id: '7',
            requesterId: 'del-1',
            targetId: 'acct-A',
            rank: 2,
        };
        const out = withDelegatePreferences([submitted], [sponsorRep, delegate]);
        expect(out).toHaveLength(1);
        expect(out[0]).toBe(submitted);
    });

    test('deduplicates a repeated id within one delegate\'s answer', () => {
        const delegate = makeAttendee('del-1', 'delegate', 'acct-D', [
            'acct-A',
            'acct-A',
        ]);
        expect(withDelegatePreferences([], [sponsorRep, delegate])).toHaveLength(1);
    });

    test('ignores sponsors and delegates with no answers', () => {
        const quiet = makeAttendee('del-2', 'delegate', 'acct-D');
        const existing = [{ id: '1', requesterId: 'acct-A', targetId: 'del-2', rank: 5 }];
        // Same array back when there's nothing to add.
        expect(withDelegatePreferences(existing, [sponsorRep, quiet])).toBe(existing);
    });

    test('tolerates an attendee predating the field (mock/fixture data)', () => {
        const legacy = makeAttendee('del-3', 'delegate', 'acct-D');
        // @ts-expect-error — simulating data written before the field existed.
        delete legacy.scheduling.requestedSponsorAccountIds;
        expect(() => withDelegatePreferences([], [sponsorRep, legacy])).not.toThrow();
        expect(withDelegatePreferences([], [sponsorRep, legacy])).toEqual([]);
    });
});
