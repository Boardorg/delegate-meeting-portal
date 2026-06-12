import { describe, test, expect } from 'vitest';
import { runScheduler } from './engine';
import type { Attendee, AttendeeSlot, MeetingRequest } from '@/types';

// ---------------------------------------------------------------------------
// Helpers for generating test data
// ---------------------------------------------------------------------------

/**
 * Helper to generate a minimal fake attendee with scheduling slots for testing.
 *
 * @param {string} id - The attendee's unique ID.
 * @param {string} company - The attendee's company name.
 * @param {'sponsor' | 'delegate'} role - The attendee's role.
 * @param {AttendeeSlot[]} slots - The attendee's available time slots.
 * @returns {Attendee} A minimal attendee object ready for use with runScheduler.
 */
function makeAttendee(id: string, company: string, role: 'sponsor' | 'delegate', slots: AttendeeSlot[]): Attendee {
    return {
        id, company, role,
        cventContactId: '', salesforceId: '', name: id, email: '', phone: '',
        title: '', sponsorTier: role === 'sponsor' ? 'standard' : null,
        profile: { annualRevenue: null, budgetaryResponsibility: null, areasOfSpecialization: [], industrySectors: [], plannedSpend: null, companySize: null, regionsOverseen: [], strategicPriorities: [] },
        scheduling: { slots, maxSameCompanyMeetings: 2 },
    };
}

/**
 * Helper to generate a fake attendee slot for testing.
 *
 * @param {string} slotId - Unique identifier for the slot.
 * @param {1 | 2} day - The event day this slot belongs to.
 * @param {string} startTime - ISO 8601 start time string.
 * @returns {AttendeeSlot} An available slot on the specified day and time.
 */
function makeSlot(slotId: string, day: 1 | 2, startTime: string): AttendeeSlot {
    return { slotId, day, startTime, endTime: startTime, status: 'available' };
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

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('runScheduler — basic functionality', () => {
    test('schedules a meeting when a sponsor requests a delegate and they share an available slot', async () => {
        const sponsor   = makeAttendee('s1', 'Acme',   'sponsor',   [makeSlot('s1-d1-01', 1, '09:00')]);
        const delegate  = makeAttendee('d1', 'Globex', 'delegate',  [makeSlot('d1-d1-01', 1, '09:00')]);
        const requests  = [makeRequest('s1', 'd1', 5)];

        const { schedule } = await runScheduler([sponsor, delegate], requests);

        expect(schedule).toHaveLength(1);
        expect(schedule[0]).toMatchObject({ attendeeA: 's1', attendeeB: 'd1', day: 1 });
    });

    test('schedules no meetings when attendees have no overlapping slots', async () => {
        const sponsor   = makeAttendee('s1', 'Acme',   'sponsor',   [makeSlot('s1-d1-01', 1, '09:00')]);
        const delegate  = makeAttendee('d1', 'Globex', 'delegate',  [makeSlot('d1-d1-01', 1, '10:00')]);
        const requests  = [makeRequest('s1', 'd1', 5)];

        const { schedule } = await runScheduler([sponsor, delegate], requests);

        expect(schedule).toHaveLength(0);
    });

    test('schedules no meetings when there are no requests', async () => {
        const sponsor   = makeAttendee('s1', 'Acme',   'sponsor',   [makeSlot('s1-d1-01', 1, '09:00')]);
        const delegate  = makeAttendee('d1', 'Globex', 'delegate',  [makeSlot('d1-d1-01', 1, '09:00')]);

        const { schedule } = await runScheduler([sponsor, delegate], []);

        expect(schedule).toHaveLength(0);
    });
});

describe('runScheduler — mutual pairs', () => {
    test('marks a meeting as mutual when both parties requested each other', async () => {
        const sponsor   = makeAttendee('s1', 'Acme',   'sponsor',   [makeSlot('s1-d1-01', 1, '09:00')]);
        const delegate  = makeAttendee('d1', 'Globex', 'delegate',  [makeSlot('d1-d1-01', 1, '09:00')]);
        const requests  = [makeRequest('s1', 'd1', 3), makeRequest('d1', 's1', 3)];

        const { schedule } = await runScheduler([sponsor, delegate], requests);

        expect(schedule).toHaveLength(1);
        expect(schedule[0].mutual).toBe(true);
    });

    test('marks a meeting as not mutual when only one party requested the other', async () => {
        const sponsor   = makeAttendee('s1', 'Acme',   'sponsor',   [makeSlot('s1-d1-01', 1, '09:00')]);
        const delegate  = makeAttendee('d1', 'Globex', 'delegate',  [makeSlot('d1-d1-01', 1, '09:00')]);
        const requests  = [makeRequest('s1', 'd1', 5)];

        const { schedule } = await runScheduler([sponsor, delegate], requests);

        expect(schedule).toHaveLength(1);
        expect(schedule[0].mutual).toBe(false);
    });

    test('schedules a mutual pair over a higher-ranked one-way request when the delegate has only one slot', async () => {
        // s1 has a higher rank request but is one-way. s2+d1 are mutual but lower rank.
        // Pass 1 claims d1's only slot for the mutual pair before Pass 2 can give it to s1.
        const s1        = makeAttendee('s1', 'Acme',    'sponsor',   [makeSlot('s1-d1-01', 1, '09:00')]);
        const s2        = makeAttendee('s2', 'Initech', 'sponsor',   [makeSlot('s2-d1-01', 1, '09:00')]);
        const d1        = makeAttendee('d1', 'Globex',  'delegate',  [makeSlot('d1-d1-01', 1, '09:00')]);
        const requests  = [
            makeRequest('s1', 'd1', 5),
            makeRequest('s2', 'd1', 3), makeRequest('d1', 's2', 3),
        ];

        const { schedule } = await runScheduler([s1, s2, d1], requests);

        expect(schedule).toHaveLength(1);
        expect(schedule[0]).toMatchObject({ attendeeA: 's2', attendeeB: 'd1', mutual: true });
    });
});

describe('runScheduler — cap enforcement', () => {
    test('does not schedule more than 7 meetings for a delegate across all passes', async () => {
        // Generate 9 sponsors each requesting the same delegate at a unique time. d1 has 9 slots.
        // Pass 2 (delegateCap: 3) + Pass 5 (delegateCap: 7) allow at most 7 total — the 9th is blocked.
        const times     = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
        const sponsors  = times.map((t, i) =>
            makeAttendee(`s${i + 1}`, `Co${i + 1}`, 'sponsor', [makeSlot(`s${i + 1}-d1-01`, 1, t)])
        );
        const d1        = makeAttendee('d1', 'Globex', 'delegate', times.map((t, i) =>
            makeSlot(`d1-d1-${String(i + 1).padStart(2, '0')}`, 1, t)
        ));
        const requests  = sponsors.map(s => makeRequest(s.id, 'd1', 5));

        const { schedule } = await runScheduler([...sponsors, d1], requests);

        expect(schedule).toHaveLength(7);
    });

    test('schedules more meetings for a diamond sponsor than a standard sponsor', async () => {
        // Diamond cap in Pass 5 is 10 and standard cap is 7.
        // Each sponsor requests 10 unique delegates so the cap — not slot availability — is the constraint.

        // Two sets of unique times: diamond slots are on the hour, standard on the half hour.
        // Keeping them separate ensures the two sponsors never compete for the same delegate slots.
        const diamondTimes  = Array.from({ length: 10 }, (_, i) => `${String(i + 9).padStart(2, '0')}:00`);
        const standardTimes = Array.from({ length: 10 }, (_, i) => `${String(i + 9).padStart(2, '0')}:30`);

        // Build the two sponsors with 10 slots each.
        // The diamond sponsor's tier is overridden after makeAttendee since makeAttendee defaults to 'standard'.
        const diamond  = { ...makeAttendee('sd', 'DiamondCo',  'sponsor', diamondTimes.map((t, i)  => makeSlot(`sd-d1-${String(i + 1).padStart(2, '0')}`, 1, t))), sponsorTier: 'diamond' as const };
        const standard = makeAttendee('ss', 'StandardCo', 'sponsor', standardTimes.map((t, i) => makeSlot(`ss-d1-${String(i + 1).padStart(2, '0')}`, 1, t)));

        // Each delegate has exactly one slot matching their sponsor's time,
        // so each sponsor-delegate pair has exactly one possible meeting time.
        const diamondDelegates  = diamondTimes.map((t, i) =>
            makeAttendee(`dd${i + 1}`, `DDCo${i + 1}`, 'delegate', [makeSlot(`dd${i + 1}-d1-01`, 1, t)])
        );
        const standardDelegates = standardTimes.map((t, i) =>
            makeAttendee(`ds${i + 1}`, `DSCo${i + 1}`, 'delegate', [makeSlot(`ds${i + 1}-d1-01`, 1, t)])
        );

        // Each sponsor requests all 10 of their delegates at rank 5.
        const requests = [
            ...diamondDelegates.map(d  => makeRequest('sd', d.id, 5)),
            ...standardDelegates.map(d => makeRequest('ss', d.id, 5)),
        ];

        const { schedule } = await runScheduler(
            [diamond, standard, ...diamondDelegates, ...standardDelegates],
            requests
        );

        // Count how many meetings each sponsor ended up with and assert on the cap difference.
        const diamondMeetings  = schedule.filter(m => m.attendeeA === 'sd').length;
        const standardMeetings = schedule.filter(m => m.attendeeA === 'ss').length;

        expect(diamondMeetings).toBe(10);
        expect(standardMeetings).toBe(7);
    });
});
