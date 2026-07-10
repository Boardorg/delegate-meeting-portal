import { describe, test, expect } from 'vitest';
import { runScheduler } from './engine';
import type { Attendee, Location, MeetingRequest, Timeslot } from '@/types';

// ---------------------------------------------------------------------------
// Helpers for generating test data
// ---------------------------------------------------------------------------

/**
 * Helper to generate a minimal fake attendee for testing. Availability is no
 * longer per-attendee — it comes from the global Timeslot[] passed to runScheduler.
 *
 * @param {string} id - The attendee's unique ID.
 * @param {string} company - The attendee's company name.
 * @param {'sponsor' | 'delegate'} role - The attendee's role.
 * @returns {Attendee} A minimal attendee object ready for use with runScheduler.
 */
function makeAttendee(id: string, company: string, role: 'sponsor' | 'delegate'): Attendee {
    return {
        id, company, role,
        cventContactId: '', salesforceId: id, name: id, email: '', phone: '',
        title: '', sponsorTier: role === 'sponsor' ? 'standard' : null,
        profile: { annualRevenue: null, budgetaryResponsibility: null, areasOfSpecialization: [], industrySectors: [], plannedSpend: null, companySize: null, regionsOverseen: [], strategicPriorities: [] },
        scheduling: { maxSameCompanyMeetings: 2 },
    };
}

/**
 * Helper to generate a single event-global timeslot for testing.
 *
 * @param {string} id - Unique identifier for the timeslot.
 * @param {1 | 2} day - The event day this timeslot belongs to.
 * @param {string} startTime - Start time string (any distinct value; treated opaquely).
 * @param {number} [capacity=1] - How many meetings may book this timeslot.
 * @returns {Timeslot} The timeslot.
 */
function makeTimeslot(id: string, day: 1 | 2, startTime: string, capacity = 1): Timeslot {
    return { id, day, startTime, endTime: startTime, capacity, locationId: null };
}

/**
 * Builds a list of day-1 timeslots, one per distinct start time, each with the
 * given capacity. Useful for tests where many pairs share the time grid.
 *
 * @param {string[]} times - Distinct start times.
 * @param {number} [capacity=1] - Capacity for each generated timeslot.
 * @returns {Timeslot[]} The timeslots.
 */
function day1Grid(times: string[], capacity = 1): Timeslot[] {
    return times.map((t, i) => makeTimeslot(`ts-${i + 1}`, 1, t, capacity));
}

/**
 * Helper to generate a fake meeting request for testing.
 *
 * @param {string} requesterId - The ID of the attendee making the request.
 * @param {string} targetId - The ID of the attendee being requested.
 * @param {number} rank - Interest level from 1 (low) to 5 (high).
 * @returns {MeetingRequest} A meeting request object with the specified fields.
 */
function makeRequest(requesterId: string, targetId: string, rank: number): MeetingRequest {
    return { id: `${requesterId}-${targetId}`, requesterId, targetId, rank };
}

// No locations are needed for these tests; the engine seeds locationId from the
// timeslot (null here) and never reads the locations array directly.
const NO_LOCATIONS: Location[] = [];

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

// Meetings get scheduled when a timeslot is available on the meeting's day.
describe('runScheduler — basic functionality', () => {
    test('schedules a meeting when a sponsor requests a delegate and a timeslot exists', async () => {
        const sponsor   = makeAttendee('s1', 'Acme',   'sponsor');
        const delegate  = makeAttendee('d1', 'Globex', 'delegate');
        const timeslots = [makeTimeslot('ts-1', 1, '09:00')];
        const requests  = [makeRequest('s1', 'd1', 5)];

        const { schedule } = await runScheduler([sponsor, delegate], requests, timeslots, NO_LOCATIONS);

        expect(schedule).toHaveLength(1);
        expect(schedule[0]).toMatchObject({ attendeeA: 's1', attendeeB: 'd1', day: 1, timeslotId: 'ts-1' });
    });

    test('schedules no meetings when no timeslot is available on the meeting day', async () => {
        // Sponsor↔delegate meetings happen on Day 1, but the only timeslot is on Day 2.
        const sponsor   = makeAttendee('s1', 'Acme',   'sponsor');
        const delegate  = makeAttendee('d1', 'Globex', 'delegate');
        const timeslots = [makeTimeslot('ts-1', 2, '09:00')];
        const requests  = [makeRequest('s1', 'd1', 5)];

        const { schedule } = await runScheduler([sponsor, delegate], requests, timeslots, NO_LOCATIONS);

        expect(schedule).toHaveLength(0);
    });

    test('schedules no meetings when there are no requests', async () => {
        const sponsor   = makeAttendee('s1', 'Acme',   'sponsor');
        const delegate  = makeAttendee('d1', 'Globex', 'delegate');
        const timeslots = [makeTimeslot('ts-1', 1, '09:00')];

        const { schedule } = await runScheduler([sponsor, delegate], [], timeslots, NO_LOCATIONS);

        expect(schedule).toHaveLength(0);
    });
});

// Mutual flag is set correctly and mutual pairs take priority over higher-ranked one-way requests.
describe('runScheduler — mutual pairs', () => {
    test('marks a meeting as mutual when both parties requested each other', async () => {
        const sponsor   = makeAttendee('s1', 'Acme',   'sponsor');
        const delegate  = makeAttendee('d1', 'Globex', 'delegate');
        const timeslots = [makeTimeslot('ts-1', 1, '09:00')];
        const requests  = [makeRequest('s1', 'd1', 3), makeRequest('d1', 's1', 3)];

        const { schedule } = await runScheduler([sponsor, delegate], requests, timeslots, NO_LOCATIONS);

        expect(schedule).toHaveLength(1);
        expect(schedule[0].mutual).toBe(true);
    });

    test('marks a meeting as not mutual when only one party requested the other', async () => {
        const sponsor   = makeAttendee('s1', 'Acme',   'sponsor');
        const delegate  = makeAttendee('d1', 'Globex', 'delegate');
        const timeslots = [makeTimeslot('ts-1', 1, '09:00')];
        const requests  = [makeRequest('s1', 'd1', 5)];

        const { schedule } = await runScheduler([sponsor, delegate], requests, timeslots, NO_LOCATIONS);

        expect(schedule).toHaveLength(1);
        expect(schedule[0].mutual).toBe(false);
    });

    test('schedules a mutual pair over a higher-ranked one-way request when only one timeslot exists', async () => {
        // s1 has a higher-ranked one-way request; s2+d1 are mutual but lower-ranked.
        // With a single capacity-1 timeslot, Pass 1 claims it for the mutual pair before
        // Pass 2 can give it to s1.
        const s1        = makeAttendee('s1', 'Acme',    'sponsor');
        const s2        = makeAttendee('s2', 'Initech', 'sponsor');
        const d1        = makeAttendee('d1', 'Globex',  'delegate');
        const timeslots = [makeTimeslot('ts-1', 1, '09:00')];
        const requests  = [
            makeRequest('s1', 'd1', 5),
            makeRequest('s2', 'd1', 3), makeRequest('d1', 's2', 3),
        ];

        const { schedule } = await runScheduler([s1, s2, d1], requests, timeslots, NO_LOCATIONS);

        expect(schedule).toHaveLength(1);
        expect(schedule[0]).toMatchObject({ attendeeA: 's2', attendeeB: 'd1', mutual: true });
    });
});

// Delegates are capped at 7 meetings total and diamond sponsors get a higher cap than standard.
describe('runScheduler — cap enforcement', () => {
    test('does not schedule more than 7 meetings for a delegate across all passes', async () => {
        // 9 sponsors each request the same delegate; 9 distinct timeslots exist. The delegate
        // gets busy at one time per meeting, so each pair lands on a distinct timeslot — but the
        // delegate cap (Pass 5: 7) blocks the 8th and 9th.
        const times     = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
        const sponsors  = times.map((_, i) => makeAttendee(`s${i + 1}`, `Co${i + 1}`, 'sponsor'));
        const d1        = makeAttendee('d1', 'Globex', 'delegate');
        const timeslots = day1Grid(times);
        const requests  = sponsors.map(s => makeRequest(s.id, 'd1', 5));

        const { schedule } = await runScheduler([...sponsors, d1], requests, timeslots, NO_LOCATIONS);

        expect(schedule).toHaveLength(7);
    });

    test('schedules more meetings for a diamond sponsor than a standard sponsor', async () => {
        // Diamond cumulative cap through Pass 5 is 8; standard is 5. Each sponsor requests 10
        // unique delegates, so the per-sponsor cap — not timeslot availability — is the constraint.
        // 10 day-1 timeslots with capacity 2 let both sponsors meet someone at the same start time.
        const timeslots = day1Grid(
            Array.from({ length: 10 }, (_, i) => `${String(i + 9).padStart(2, '0')}:00`),
            2,
        );

        // makeAttendee defaults to 'standard'; override the diamond sponsor's tier.
        const diamond  = { ...makeAttendee('sd', 'DiamondCo', 'sponsor'), sponsorTier: 'diamond' as const };
        const standard = makeAttendee('ss', 'StandardCo', 'sponsor');

        // Each sponsor has 10 distinct delegates so they never compete for the same partner.
        const diamondDelegates  = Array.from({ length: 10 }, (_, i) => makeAttendee(`dd${i + 1}`, `DDCo${i + 1}`, 'delegate'));
        const standardDelegates = Array.from({ length: 10 }, (_, i) => makeAttendee(`ds${i + 1}`, `DSCo${i + 1}`, 'delegate'));

        const requests = [
            ...diamondDelegates.map(d  => makeRequest('sd', d.id, 5)),
            ...standardDelegates.map(d => makeRequest('ss', d.id, 5)),
        ];

        const { schedule } = await runScheduler(
            [diamond, standard, ...diamondDelegates, ...standardDelegates],
            requests,
            timeslots,
            NO_LOCATIONS,
        );

        const diamondMeetings  = schedule.filter(m => m.attendeeA === 'sd').length;
        const standardMeetings = schedule.filter(m => m.attendeeA === 'ss').length;

        expect(diamondMeetings).toBe(8);
        expect(standardMeetings).toBe(5);
    });
});

// Same-company cap blocks meetings once reached and sponsors from other companies are unaffected.
describe('runScheduler — company diversity', () => {
    test('blocks a third meeting when the delegate has already met the same-company cap', async () => {
        // makeAttendee sets maxSameCompanyMeetings: 2, so the third Acme sponsor is blocked.
        const s1 = makeAttendee('s1', 'Acme', 'sponsor');
        const s2 = makeAttendee('s2', 'Acme', 'sponsor');
        const s3 = makeAttendee('s3', 'Acme', 'sponsor');
        const d1 = makeAttendee('d1', 'Globex', 'delegate');
        const timeslots = day1Grid(['09:00', '10:00', '11:00']);
        const requests = [
            makeRequest('s1', 'd1', 5),
            makeRequest('s2', 'd1', 5),
            makeRequest('s3', 'd1', 5),
        ];

        const { schedule } = await runScheduler([s1, s2, s3, d1], requests, timeslots, NO_LOCATIONS);

        expect(schedule).toHaveLength(2);
        expect(schedule.every(m => m.attendeeB === 'd1')).toBe(true);
    });

    test('does not block sponsors from different companies after the same-company cap is reached', async () => {
        // s1 and s2 fill d1's Acme cap. s3 is from a different company and should still get through.
        const s1 = makeAttendee('s1', 'Acme',   'sponsor');
        const s2 = makeAttendee('s2', 'Acme',   'sponsor');
        const s3 = makeAttendee('s3', 'Globex', 'sponsor');
        const d1 = makeAttendee('d1', 'Initech', 'delegate');
        const timeslots = day1Grid(['09:00', '10:00', '11:00']);
        const requests = [
            makeRequest('s1', 'd1', 5),
            makeRequest('s2', 'd1', 5),
            makeRequest('s3', 'd1', 5),
        ];

        const { schedule } = await runScheduler([s1, s2, s3, d1], requests, timeslots, NO_LOCATIONS);

        expect(schedule).toHaveLength(3);
    });
});
