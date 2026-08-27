import { describe, test, expect } from 'vitest';
import { runScheduler } from './engine';
import { pairKey } from './helpers';
import type { Attendee, Location, MeetingRequest, Timeslot } from '@/types';

// ---------------------------------------------------------------------------
// Helpers for generating test data
// ---------------------------------------------------------------------------

/**
 * Helper to generate a minimal fake attendee for testing. Availability is no
 * longer per-attendee — it comes from the global Timeslot[] passed to runScheduler.
 *
 * `accountId` defaults to `id`, so by default each sponsor is its own company
 * (party id === its own id) and existing single-rep tests are unchanged. Pass a
 * shared accountId to model multiple reps of one company.
 *
 * @param {string} id - The attendee's unique ID.
 * @param {string} company - The attendee's company name.
 * @param {'sponsor' | 'delegate'} role - The attendee's role.
 * @param {string} [accountId=id] - Salesforce Account id (the sponsor party id).
 * @returns {Attendee} A minimal attendee object ready for use with runScheduler.
 */
function makeAttendee(id: string, company: string, role: 'sponsor' | 'delegate', accountId: string = id): Attendee {
    return {
        id, company, role, accountId,
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
    return { id, day, startTime, endTime: startTime, capacity, locationId: null, appointmentTypeId: 'type-1' };
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

// Company diversity now keys on the account id (party id), and a company's reps
// collapse to one scheduling entity.
describe('runScheduler — company diversity (by account)', () => {
    test('collapses reps of one company into a single meeting with a delegate', async () => {
        // Two reps sharing an account request the same delegate → one company
        // meeting, keyed by the account id on attendeeA (not a rep id).
        const s1 = makeAttendee('s1', 'Acme', 'sponsor', 'acct-acme');
        const s2 = makeAttendee('s2', 'Acme', 'sponsor', 'acct-acme');
        const d1 = makeAttendee('d1', 'Globex', 'delegate');
        const timeslots = day1Grid(['09:00', '10:00', '11:00']);
        const requests = [
            makeRequest('s1', 'd1', 5),
            makeRequest('s2', 'd1', 5),
        ];

        const { schedule } = await runScheduler([s1, s2, d1], requests, timeslots, NO_LOCATIONS);

        expect(schedule).toHaveLength(1);
        expect(schedule[0]).toMatchObject({ attendeeA: 'acct-acme', attendeeB: 'd1' });
    });

    test('does not block companies from different accounts meeting the same delegate', async () => {
        // Three distinct-account sponsors each meet d1 — different companies, so
        // the delegate's same-company cap never triggers.
        const s1 = makeAttendee('s1', 'Acme',   'sponsor', 'acct-a');
        const s2 = makeAttendee('s2', 'Initech', 'sponsor', 'acct-b');
        const s3 = makeAttendee('s3', 'Globex', 'sponsor', 'acct-c');
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

    test('blocks a delegate from over-meeting the same company on day 2', async () => {
        // dx mutually requests three delegates who share an account. dx's
        // same-company cap (2) allows only two of them.
        const dx  = makeAttendee('dx',  'Xco',  'delegate', 'acct-dx');
        const dd1 = makeAttendee('dd1', 'Sco', 'delegate', 'acct-s');
        const dd2 = makeAttendee('dd2', 'Sco', 'delegate', 'acct-s');
        const dd3 = makeAttendee('dd3', 'Sco', 'delegate', 'acct-s');
        const timeslots = [makeTimeslot('t1', 2, '09:00'), makeTimeslot('t2', 2, '10:00'), makeTimeslot('t3', 2, '11:00')];
        const requests = [
            makeRequest('dx', 'dd1', 5), makeRequest('dd1', 'dx', 5),
            makeRequest('dx', 'dd2', 5), makeRequest('dd2', 'dx', 5),
            makeRequest('dx', 'dd3', 5), makeRequest('dd3', 'dx', 5),
        ];

        const { schedule } = await runScheduler([dx, dd1, dd2, dd3], requests, timeslots, NO_LOCATIONS);

        const dxMeetings = schedule.filter(m => m.attendeeA === 'dx' || m.attendeeB === 'dx');
        expect(dxMeetings).toHaveLength(2);
    });
});

// A company (all its reps) is one scheduling unit: combined schedule + one
// shared meeting budget, and meetings are keyed by the company account id.
describe('runScheduler — company-level (multi-rep) scheduling', () => {
    test('unions reps\' pre-existing busy times under the company account', async () => {
        // A rep is already booked at 09:00 (seeded under the company account id).
        // The company must book the only other slot, 10:00.
        const s1 = makeAttendee('s1', 'Acme', 'sponsor', 'acct-acme');
        const s2 = makeAttendee('s2', 'Acme', 'sponsor', 'acct-acme');
        const d1 = makeAttendee('d1', 'Globex', 'delegate');
        const timeslots = day1Grid(['09:00', '10:00']);
        const requests = [makeRequest('s1', 'd1', 5)];

        const { schedule } = await runScheduler([s1, s2, d1], requests, timeslots, NO_LOCATIONS, {
            busyStartTimesByAttendee: new Map([['acct-acme', new Set(['09:00'])]]),
        });

        expect(schedule).toHaveLength(1);
        expect(schedule[0]).toMatchObject({ attendeeA: 'acct-acme', timeslotId: 'ts-2' });
    });

    test('shares one standard budget (5) across a company\'s reps', async () => {
        // Two reps of one standard company request 8 distinct delegates between
        // them; the shared cap holds the company to 5 meetings total.
        const s1 = makeAttendee('s1', 'Acme', 'sponsor', 'acct-acme');
        const s2 = makeAttendee('s2', 'Acme', 'sponsor', 'acct-acme');
        const delegates = Array.from({ length: 8 }, (_, i) => makeAttendee(`d${i + 1}`, `Co${i + 1}`, 'delegate'));
        const timeslots = day1Grid(Array.from({ length: 8 }, (_, i) => `${String(i + 9).padStart(2, '0')}:00`));
        const requests = delegates.map((d, i) => makeRequest(i % 2 === 0 ? 's1' : 's2', d.id, 5));

        const { schedule } = await runScheduler([s1, s2, ...delegates], requests, timeslots, NO_LOCATIONS);

        const companyMeetings = schedule.filter(m => m.attendeeA === 'acct-acme');
        expect(companyMeetings).toHaveLength(5);
    });

    test('shares one diamond budget (8) across a company\'s reps', async () => {
        const s1 = { ...makeAttendee('s1', 'DiamondCo', 'sponsor', 'acct-dia'), sponsorTier: 'diamond' as const };
        // Second rep is standard; highest-tier-wins keeps the company diamond (8).
        const s2 = makeAttendee('s2', 'DiamondCo', 'sponsor', 'acct-dia');
        const delegates = Array.from({ length: 10 }, (_, i) => makeAttendee(`d${i + 1}`, `Co${i + 1}`, 'delegate'));
        const timeslots = day1Grid(Array.from({ length: 10 }, (_, i) => `${String(i + 9).padStart(2, '0')}:00`));
        const requests = delegates.map((d, i) => makeRequest(i % 2 === 0 ? 's1' : 's2', d.id, 5));

        const { schedule } = await runScheduler([s1, s2, ...delegates], requests, timeslots, NO_LOCATIONS);

        const companyMeetings = schedule.filter(m => m.attendeeA === 'acct-dia');
        expect(companyMeetings).toHaveLength(8);
    });

    test('keys a meeting by the company account even when the request used a rep id', async () => {
        const s1 = makeAttendee('s1', 'Acme', 'sponsor', 'acct-acme');
        const d1 = makeAttendee('d1', 'Globex', 'delegate');
        const timeslots = [makeTimeslot('ts-1', 1, '09:00')];
        // Request keyed by the rep's salesforceId — must resolve to the account.
        const requests = [makeRequest('s1', 'd1', 5)];

        const { schedule } = await runScheduler([s1, d1], requests, timeslots, NO_LOCATIONS);

        expect(schedule).toHaveLength(1);
        expect(schedule[0].attendeeA).toBe('acct-acme');
    });
});

// Pre-existing Cvent meetings are scheduled around: their pairs aren't re-created
// and their times don't get double-booked.
describe('runScheduler — pre-existing Cvent schedule', () => {
    test('does not re-schedule a pair that already meets in Cvent', async () => {
        const s1 = makeAttendee('s1', 'Acme', 'sponsor');
        const d1 = makeAttendee('d1', 'Globex', 'delegate');
        const timeslots = [makeTimeslot('ts-1', 1, '09:00')];
        const requests = [makeRequest('s1', 'd1', 5)];

        const { schedule } = await runScheduler([s1, d1], requests, timeslots, NO_LOCATIONS, {
            pairs: new Set([pairKey('s1', 'd1')]),
        });

        expect(schedule).toHaveLength(0);
    });

    test('does not book an attendee at a time they are already booked in Cvent', async () => {
        // d1 is already busy at 09:00 (the only timeslot), so the meeting can't be placed.
        const s1 = makeAttendee('s1', 'Acme', 'sponsor');
        const d1 = makeAttendee('d1', 'Globex', 'delegate');
        const timeslots = [makeTimeslot('ts-1', 1, '09:00')];
        const requests = [makeRequest('s1', 'd1', 5)];

        const { schedule } = await runScheduler([s1, d1], requests, timeslots, NO_LOCATIONS, {
            busyStartTimesByAttendee: new Map([["d1", new Set(["09:00"])]]),
        });

        expect(schedule).toHaveLength(0);
    });

    test('still schedules the pair at a free time when another time is pre-booked', async () => {
        // d1 is busy at 09:00 but 10:00 is open, so the meeting lands at 10:00.
        const s1 = makeAttendee('s1', 'Acme', 'sponsor');
        const d1 = makeAttendee('d1', 'Globex', 'delegate');
        const timeslots = day1Grid(['09:00', '10:00']);
        const requests = [makeRequest('s1', 'd1', 5)];

        const { schedule } = await runScheduler([s1, d1], requests, timeslots, NO_LOCATIONS, {
            busyStartTimesByAttendee: new Map([["d1", new Set(["09:00"])]]),
        });

        expect(schedule).toHaveLength(1);
        expect(schedule[0].timeslotId).toBe("ts-2");
    });
});
