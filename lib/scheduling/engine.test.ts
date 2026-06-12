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
