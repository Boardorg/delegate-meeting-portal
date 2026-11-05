import { describe, test, expect } from 'vitest';
import { runScheduler, sponsorPassCap, SPONSOR_PASS_SHARES } from './engine';
import { pairKey } from './helpers';
import { resolveCompanyBooths, type BoothLocations } from './booths';
import { sponsorCompaniesByAccountId } from '@/lib/attendees/companies';
import { preexistingFromAppointments } from '@/lib/cvent/preexisting';
import type { CventExistingAppointment } from '@/lib/cvent/client';
import { emptyProfile } from '@/lib/attendees/formatProfile';
import type { Attendee, Location, MeetingRequest, ScheduledMeeting, Timeslot } from '@/types';

// ---------------------------------------------------------------------------
// The scheduler with sponsor booths, Salesforce meeting counts and meetings at once.
// ---------------------------------------------------------------------------

/**
 * Builds a sponsor rep.
 * Every rep has a Cvent contact id unless the test clears it, so it can host.
 *
 * @param {string} id - The rep's Salesforce id.
 * @param {string} accountId - The company's Account id.
 * @param {Partial<Attendee>} [partial] - Fields to set.
 * @returns {Attendee} The rep.
 */
function sponsor(id: string, accountId: string, partial: Partial<Attendee> = {}): Attendee {
    return {
        id,
        cventContactId: partial.cventContactId ?? `cvent-${id}`,
        salesforceId: id,
        accountId,
        name: id,
        email: '',
        phone: '',
        role: 'sponsor',
        company: accountId,
        title: '',
        sponsorTier: partial.sponsorTier ?? 'standard',
        opportunityId: partial.opportunityId ?? `opp-${accountId}`,
        boothNo: partial.boothNo === undefined ? null : partial.boothNo,
        purchasedMeetings: partial.purchasedMeetings ?? null,
        bonusMeetings: partial.bonusMeetings ?? null,
        maximumMeetings: partial.maximumMeetings ?? null,
        meetingsAtOnce: partial.meetingsAtOnce ?? null,
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: null, requestedSponsorAccountIds: [] },
    };
}

/**
 * Builds delegates d1..dN, each at a different company so diversity never applies.
 *
 * @param {number} count - How many delegates.
 * @returns {Attendee[]} The delegates.
 */
function delegates(count: number): Attendee[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `d${i + 1}`,
        cventContactId: `cvent-d${i + 1}`,
        salesforceId: `d${i + 1}`,
        accountId: `acct-d${i + 1}`,
        name: `d${i + 1}`,
        email: '',
        phone: '',
        role: 'delegate',
        company: `DCo${i + 1}`,
        title: '',
        sponsorTier: null,
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: 2, requestedSponsorAccountIds: [] },
    }));
}

/**
 * Builds a sponsor_delegate slot at a location.
 *
 * @param {string} id - The slot id.
 * @param {1 | 2} day - The event day.
 * @param {string} startTime - The start time.
 * @param {string} locationId - The location.
 * @param {number} [capacity=1] - Cvent's per-slot limit.
 * @returns {Timeslot} The slot.
 */
function slot(id: string, day: 1 | 2, startTime: string, locationId: string, capacity = 1): Timeslot {
    return {
        id, day, startTime, endTime: startTime, capacity, locationId,
        appointmentTypeId: 't-s2d', appointmentTypeName: 'Sponsor to Delegate Meetings',
        kind: 'sponsor_delegate',
    };
}

/**
 * Builds booth slots for one location, one per start time.
 *
 * @param {string} locationId - The booth location.
 * @param {1 | 2} day - The event day.
 * @param {string[]} times - The start times.
 * @param {number} [capacity=1] - Cvent's per-slot limit.
 * @returns {Timeslot[]} The slots.
 */
function boothSlots(locationId: string, day: 1 | 2, times: string[], capacity = 1): Timeslot[] {
    return times.map(t => slot(`${locationId}-d${day}-${t}`, day, `d${day}-${t}`, locationId, capacity));
}

/**
 * Builds a Cvent location.
 *
 * @param {string} id - The location id.
 * @param {string} name - The location name.
 * @returns {Location} The location.
 */
function loc(id: string, name: string): Location {
    return { id, name, capacity: Infinity, parentLocationId: null };
}

const LOCATIONS = [loc('b1', 'Booth 1'), loc('b2', 'Booth 2'), loc('b3', 'Booth 3'), loc('b4', 'Booth 4'), loc('b5', 'Booth 5'), loc('tbl', 'Table 1A')];

/**
 * One request per delegate, from a company.
 *
 * @param {string} accountId - The requesting company.
 * @param {Attendee[]} ds - The delegates.
 * @returns {MeetingRequest[]} The requests.
 */
function requestsFrom(accountId: string, ds: Attendee[]): MeetingRequest[] {
    return ds.map(d => ({ id: `${accountId}-${d.id}`, requesterId: accountId, targetId: d.salesforceId, rank: 5 }));
}

/**
 * Runs the scheduler with booths resolved from the attendees.
 *
 * @param {Attendee[]} attendees - Everyone.
 * @param {MeetingRequest[]} requests - The requests.
 * @param {Timeslot[]} timeslots - The slots.
 * @param {BoothLocations | null} [mappings] - The manual booth mapping.
 * @param {Parameters<typeof runScheduler>[4]} [preexisting] - Pre-existing Cvent schedule.
 * @returns The engine's result.
 */
async function run(
    attendees: Attendee[],
    requests: MeetingRequest[],
    timeslots: Timeslot[],
    mappings: BoothLocations | null = null,
    preexisting: Parameters<typeof runScheduler>[4] = {},
) {
    const booths = resolveCompanyBooths(
        [...sponsorCompaniesByAccountId(attendees).values()],
        LOCATIONS,
        mappings,
    );
    return runScheduler(attendees, requests, timeslots, LOCATIONS, preexisting, booths);
}

/**
 * Counts a party's meetings at each start time.
 *
 * @param {ScheduledMeeting[]} schedule - The meetings.
 * @param {Timeslot[]} timeslots - The slots, for start times.
 * @param {string} party - The party id.
 * @returns {number} The most meetings the party has at one start time.
 */
function mostAtOnce(schedule: ScheduledMeeting[], timeslots: Timeslot[], party: string): number {
    const byId = new Map(timeslots.map(t => [t.id, t]));
    const counts = new Map<string, number>();
    for (const m of schedule) {
        if (m.attendeeA !== party && m.attendeeB !== party) continue;
        const start = byId.get(m.timeslotId)!.startTime;
        counts.set(start, (counts.get(start) ?? 0) + 1);
    }
    return Math.max(0, ...counts.values());
}

describe('sponsorPassCap', () => {
    /**
     * The caps for passes 1 to 5 for one maximum.
     *
     * @param {number} max - The company's maximum.
     * @returns {number[]} The five caps.
     */
    const caps = (max: number) => ([1, 2, 3, 4, 5] as const).map(p => sponsorPassCap(max, SPONSOR_PASS_SHARES[p]));

    test('a maximum of 5 gives 2, 3, 4, 5, 5', () => {
        expect(caps(5)).toEqual([2, 3, 4, 5, 5]);
    });

    test('a maximum of 2 gives 1, 1, 2, 2, 2', () => {
        expect(caps(2)).toEqual([1, 1, 2, 2, 2]);
    });

    test("a maximum of 8 gives today's diamond pattern of 3, 4, 6, 8, 8", () => {
        expect(caps(8)).toEqual([3, 4, 6, 8, 8]);
    });

    test('a maximum of 1 gives at least 1 in every pass, and 0 gives 0', () => {
        expect(caps(1)).toEqual([1, 1, 1, 1, 1]);
        expect(caps(0)).toEqual([0, 0, 0, 0, 0]);
    });
});

describe('runScheduler — meeting counts from Salesforce', () => {
    test('a company with a maximum of 2 gets 1 meeting in pass 1, then 2 by the end', async () => {
        const s = sponsor('s1', 'acct-a', { boothNo: '1', maximumMeetings: 2 });
        const ds = delegates(4);
        // Mutual requests, so pass 1 (cap 1 of 2) books first.
        const requests = [
            ...requestsFrom('acct-a', ds),
            ...ds.map(d => ({ id: `${d.id}-a`, requesterId: d.salesforceId, targetId: 'acct-a', rank: 5 })),
        ];
        const { schedule } = await run([s, ...ds], requests, boothSlots('b1', 1, ['09', '10', '11', '12']));

        expect(schedule.filter(m => m.passNumber === 1)).toHaveLength(1);
        expect(schedule).toHaveLength(2);
    });

    test('a maximum of 0 gives no meetings and says no_package_meetings, with no tier fallback', async () => {
        const s = sponsor('s1', 'acct-a', { boothNo: '1', purchasedMeetings: 0, sponsorTier: 'diamond' });
        const ds = delegates(2);
        const { schedule, skipReasons } = await run([s, ...ds], requestsFrom('acct-a', ds), boothSlots('b1', 1, ['09', '10']));

        expect(schedule).toHaveLength(0);
        expect(skipReasons.get(pairKey('acct-a', 'd1'))).toBe('no_package_meetings');
    });

    test('a maximum of 0 gives no meetings even without booths', async () => {
        const s = sponsor('s1', 'acct-a', { maximumMeetings: 0 });
        const ds = delegates(1);
        const { schedule, skipReasons } = await runScheduler([s, ...ds], requestsFrom('acct-a', ds), boothSlots('b1', 1, ['09']), LOCATIONS);

        expect(schedule).toHaveLength(0);
        expect(skipReasons.get(pairKey('acct-a', 'd1'))).toBe('no_package_meetings');
    });

    test('a "DIAMOND" package with a maximum of 4 gets at most 4, and can still spill over to Day 2', async () => {
        const s = sponsor('s1', 'acct-a', { boothNo: '1', maximumMeetings: 4, sponsorTier: 'diamond' });
        const ds = delegates(10);
        // Only 2 Day 1 times at the booth, and plenty on Day 2.
        const timeslots = [...boothSlots('b1', 1, ['09', '10']), ...boothSlots('b1', 2, ['09', '10', '11', '12', '13'])];
        const { schedule } = await run([s, ...ds], requestsFrom('acct-a', ds), timeslots);

        expect(schedule).toHaveLength(4);
        expect(schedule.filter(m => m.day === 1)).toHaveLength(2);
        expect(schedule.filter(m => m.day === 2)).toHaveLength(2);
    });
});

describe('runScheduler — booths', () => {
    test("never books a company outside its booth, even when another location is free and earlier", async () => {
        const s = sponsor('s1', 'acct-a', { boothNo: '3' });
        const ds = delegates(3);
        const timeslots = [
            slot('tbl-08', 1, '08', 'tbl', 5),
            slot('b1-08', 1, '08', 'b1', 5),
            slot('b3-10', 1, '10', 'b3'),
            slot('b3-11', 1, '11', 'b3'),
        ];
        const { schedule, skipReasons } = await run([s, ...ds], requestsFrom('acct-a', ds), timeslots);

        expect(schedule).toHaveLength(2);
        expect(schedule.every(m => m.locationId === 'b3')).toBe(true);
        expect(skipReasons.get(pairKey('acct-a', 'd3'))).toBe('no_availability');
    });

    test('a manual mapping sends the company to the mapped location', async () => {
        const s = sponsor('s1', 'acct-a', { boothNo: '3' });
        const ds = delegates(1);
        const timeslots = [slot('b3-09', 1, '09', 'b3'), slot('b4-10', 1, '10', 'b4')];
        const { schedule } = await run([s, ...ds], requestsFrom('acct-a', ds), timeslots, { '3': 'b4' });

        expect(schedule.map(m => m.locationId)).toEqual(['b4']);
    });

    test('each booth problem gives that company no meetings and its reason, while others are still scheduled', async () => {
        const ds = delegates(1);
        const companies = [
            sponsor('ok', 'acct-ok', { boothNo: '1' }),
            sponsor('nb', 'acct-no-booth', { boothNo: null }),
            sponsor('nf', 'acct-not-found', { boothNo: '99' }),
            sponsor('stale', 'acct-stale', { boothNo: '4' }),
            sponsor('c1', 'acct-conflict-1', { boothNo: '2' }),
            sponsor('c2', 'acct-conflict-2', { boothNo: 'Booth 2' }),
            sponsor('mo1', 'acct-multi', { boothNo: '3', opportunityId: 'opp-x' }),
            sponsor('mo2', 'acct-multi', { boothNo: '3', opportunityId: 'opp-y' }),
            sponsor('zero', 'acct-zero', { boothNo: '5', purchasedMeetings: 0 }),
        ];
        // Every location has a free slot, so only the booth rules can stop a meeting.
        const timeslots = LOCATIONS.map(l => slot(`${l.id}-09`, 1, '09', l.id, 10));
        const accounts = [...new Set(companies.map(c => c.accountId))];
        const requests = accounts.map(a => ({ id: a, requesterId: a, targetId: 'd1', rank: 5 }));

        const { schedule, skipReasons } = await run(
            [...companies, ...ds],
            requests,
            timeslots,
            { '4': 'loc-no-longer-in-cvent' },
        );

        expect(schedule.map(m => m.attendeeA)).toEqual(['acct-ok']);
        /**
         * The skip reason for a company's request to d1.
         *
         * @param {string} a - The company's Account id.
         * @returns {string | undefined} The reason.
         */
        const reason = (a: string) => skipReasons.get(pairKey(a, 'd1'));
        expect(reason('acct-no-booth')).toBe('no_booth');
        expect(reason('acct-not-found')).toBe('booth_not_found');
        expect(reason('acct-stale')).toBe('booth_not_found');
        expect(reason('acct-conflict-1')).toBe('booth_conflict');
        expect(reason('acct-conflict-2')).toBe('booth_conflict');
        expect(reason('acct-multi')).toBe('multiple_opportunities');
        expect(reason('acct-zero')).toBe('no_package_meetings');
    });

    test('when two companies claim the same booth, neither gets meetings', async () => {
        const ds = delegates(2);
        const a = sponsor('s1', 'acct-a', { boothNo: '1' });
        const b = sponsor('s2', 'acct-b', { boothNo: 'booth 1' });
        const { schedule, skipReasons } = await run(
            [a, b, ...ds],
            [...requestsFrom('acct-a', ds), ...requestsFrom('acct-b', ds)],
            boothSlots('b1', 1, ['09', '10', '11'], 2),
        );

        expect(schedule).toHaveLength(0);
        expect(skipReasons.get(pairKey('acct-a', 'd1'))).toBe('booth_conflict');
        expect(skipReasons.get(pairKey('acct-b', 'd1'))).toBe('booth_conflict');
    });

    test('a company missing from the booths it was given gets no meetings', async () => {
        const s = sponsor('s1', 'acct-a', { boothNo: '1' });
        const ds = delegates(1);
        const { schedule, skipReasons } = await runScheduler(
            [s, ...ds], requestsFrom('acct-a', ds), boothSlots('b1', 1, ['09']), LOCATIONS, {}, new Map(),
        );

        expect(schedule).toHaveLength(0);
        expect(skipReasons.get(pairKey('acct-a', 'd1'))).toBe('no_booth');
    });
});

describe('runScheduler — meetings at once', () => {
    test('Diaries 2 and two reps can get two meetings at the same start time, at its booth', async () => {
        const a = [
            sponsor('s1', 'acct-a', { boothNo: '1', meetingsAtOnce: 2 }),
            sponsor('s2', 'acct-a', { boothNo: '1', meetingsAtOnce: 2 }),
        ];
        const ds = delegates(2);
        const timeslots = boothSlots('b1', 1, ['09'], 2);
        const { schedule } = await run([...a, ...ds], requestsFrom('acct-a', ds), timeslots);

        expect(schedule).toHaveLength(2);
        expect(mostAtOnce(schedule, timeslots, 'acct-a')).toBe(2);
        expect(schedule.every(m => m.locationId === 'b1')).toBe(true);
    });

    test("is still held to Cvent's per-slot limit", async () => {
        const a = [
            sponsor('s1', 'acct-a', { boothNo: '1', meetingsAtOnce: 2 }),
            sponsor('s2', 'acct-a', { boothNo: '1', meetingsAtOnce: 2 }),
        ];
        const ds = delegates(2);
        const timeslots = boothSlots('b1', 1, ['09'], 1);
        const { schedule } = await run([...a, ...ds], requestsFrom('acct-a', ds), timeslots);

        expect(schedule).toHaveLength(1);
    });

    test('Diaries 2 but only one rep who can host never gets two at the same time', async () => {
        const a = [
            sponsor('s1', 'acct-a', { boothNo: '1', meetingsAtOnce: 2 }),
            sponsor('s2', 'acct-a', { boothNo: '1', meetingsAtOnce: 2, cventContactId: '' }),
        ];
        const ds = delegates(4);
        const timeslots = boothSlots('b1', 1, ['09', '10'], 2);
        const { schedule } = await run([...a, ...ds], requestsFrom('acct-a', ds), timeslots);

        expect(schedule).toHaveLength(2);
        expect(mostAtOnce(schedule, timeslots, 'acct-a')).toBe(1);
    });

    test('a blank Diaries field allows one meeting at a time', async () => {
        const a = [
            sponsor('s1', 'acct-a', { boothNo: '1' }),
            sponsor('s2', 'acct-a', { boothNo: '1' }),
        ];
        const ds = delegates(4);
        const timeslots = boothSlots('b1', 1, ['09', '10'], 2);
        const { schedule } = await run([...a, ...ds], requestsFrom('acct-a', ds), timeslots);

        expect(schedule).toHaveLength(2);
        expect(mostAtOnce(schedule, timeslots, 'acct-a')).toBe(1);
    });

    test('a delegate never gets two meetings at the same start time', async () => {
        // Two companies at their own booths, both free at 09:00, both want d1.
        const a = sponsor('s1', 'acct-a', { boothNo: '1', meetingsAtOnce: 2 });
        const b = sponsor('s2', 'acct-b', { boothNo: '2', meetingsAtOnce: 2 });
        const ds = delegates(1);
        const timeslots = [slot('b1-09', 1, '09', 'b1', 2), slot('b2-09', 1, '09', 'b2', 2)];
        const { schedule, skipReasons } = await run(
            [a, b, ...ds],
            [...requestsFrom('acct-a', ds), ...requestsFrom('acct-b', ds)],
            timeslots,
        );

        expect(schedule).toHaveLength(1);
        expect(mostAtOnce(schedule, timeslots, 'd1')).toBe(1);
        expect([...skipReasons.values()]).toContain('no_availability');
    });

    test('appointments already in Cvent count toward meetings at once', async () => {
        const a = [
            sponsor('s1', 'acct-a', { boothNo: '1', meetingsAtOnce: 2 }),
            sponsor('s2', 'acct-a', { boothNo: '1', meetingsAtOnce: 2 }),
        ];
        const ds = delegates(3);
        const timeslots = boothSlots('b1', 1, ['09'], 3);

        // One appointment at 09:00 already, so only one more fits.
        const one = await run([...a, ...ds], requestsFrom('acct-a', ds), timeslots, null, {
            busyStartTimesByAttendee: new Map([['acct-a', new Map([['d1-09', 1]])]]),
        });
        expect(one.schedule).toHaveLength(1);

        // Two already, so none fit.
        const two = await run([...a, ...ds], requestsFrom('acct-a', ds), timeslots, null, {
            busyStartTimesByAttendee: new Map([['acct-a', new Map([['d1-09', 2]])]]),
        });
        expect(two.schedule).toHaveLength(0);
    });
});

// Cvent-shaped times, so pre-existing appointments built by preexistingFromAppointments line up with the slots.
const T9 = '2026-11-10T09:00:00.000Z';
const T10 = '2026-11-10T10:00:00.000Z';

/**
 * Builds a sponsor slot at a real ISO time.
 *
 * @param {string} locationId - The booth.
 * @param {string} startTime - The ISO start time.
 * @param {number} capacity - Cvent's static per-slot setting.
 * @returns {Timeslot} The slot.
 */
function isoSlot(locationId: string, startTime: string, capacity: number): Timeslot {
    return slot(`${locationId}-${startTime}`, 1, startTime, locationId, capacity);
}

/**
 * Builds an existing Cvent appointment.
 *
 * @param {string} startTime - ISO start time.
 * @param {string[]} hosts - Host contact ids.
 * @param {string[]} attendees - Attendee contact ids.
 * @param {string | null} [locationName] - The location name.
 * @returns {CventExistingAppointment} The appointment.
 */
function cventAppt(
    startTime: string,
    hosts: string[],
    attendees: string[],
    locationName: string | null = 'Booth 1',
): CventExistingAppointment {
    return { id: null, startTime, participantContactIds: [...hosts, ...attendees], hostContactIds: hosts, locationName };
}

describe('runScheduler — existing Cvent appointments', () => {
    test('a maximum of 5 with 5 meetings already pushed gets no new meetings', async () => {
        const s = sponsor('s1', 'acct-a', { boothNo: '1', maximumMeetings: 5 });
        const ds = delegates(7);
        const { schedule, skipReasons } = await run(
            [s, ...ds],
            requestsFrom('acct-a', ds.slice(5)),
            boothSlots('b1', 1, ['09', '10', '11', '12']),
            null,
            { meetingCountByParty: new Map([['acct-a', 5]]) },
        );

        expect(schedule).toHaveLength(0);
        expect(skipReasons.get(pairKey('acct-a', 'd6'))).toBe('cap_reached');
    });

    test('existing appointments in Cvent count toward the maximum, read through preexistingFromAppointments', async () => {
        const s = sponsor('s1', 'acct-a', { boothNo: '1', maximumMeetings: 3 });
        const ds = delegates(5);
        const attendees = [s, ...ds];
        const preexisting = preexistingFromAppointments(
            [cventAppt(T9, ['cvent-s1'], ['cvent-d1']), cventAppt(T10, ['cvent-s1'], ['cvent-d2'])],
            attendees,
        );
        const timeslots = ['2026-11-10T11:00:00.000Z', '2026-11-10T12:00:00.000Z', '2026-11-10T13:00:00.000Z'].map(t => isoSlot('b1', t, 1));

        const { schedule } = await run(attendees, requestsFrom('acct-a', ds.slice(2)), timeslots, null, preexisting);

        expect(schedule).toHaveLength(1);
    });

    test("C2: a meeting pushed alone with every rep leaves no free rep, so no second meeting goes at that time", async () => {
        const a = [
            sponsor('s1', 'acct-a', { boothNo: '1', meetingsAtOnce: 2 }),
            sponsor('s2', 'acct-a', { boothNo: '1', meetingsAtOnce: 2 }),
        ];
        const ds = delegates(2);
        const attendees = [...a, ...ds];
        // M1 is in Cvent at 09:00, hosted by both reps.
        const preexisting = preexistingFromAppointments(
            [cventAppt(T9, ['cvent-s1', 'cvent-s2'], ['cvent-d1'])],
            attendees,
        );

        const { schedule } = await run(attendees, requestsFrom('acct-a', [ds[1]]), [isoSlot('b1', T9, 2)], null, preexisting);

        expect(schedule).toHaveLength(0);
    });

    test('C3: a Cvent-native appointment hosted by two of three reps leaves one free, so only one more meeting goes at that time', async () => {
        const a = [
            sponsor('s1', 'acct-a', { boothNo: '1', meetingsAtOnce: 3 }),
            sponsor('s2', 'acct-a', { boothNo: '1', meetingsAtOnce: 3 }),
            sponsor('s3', 'acct-a', { boothNo: '1', meetingsAtOnce: 3 }),
        ];
        const ds = delegates(4);
        const attendees = [...a, ...ds];
        // Made in Cvent directly, at 09:00, hosted by s1 and s2.
        const preexisting = preexistingFromAppointments(
            [cventAppt(T9, ['cvent-s1', 'cvent-s2'], ['cvent-d1'])],
            attendees,
        );

        const { schedule } = await run(attendees, requestsFrom('acct-a', ds.slice(1)), [isoSlot('b1', T9, 5)], null, preexisting);

        // Diaries and the room would allow two more, but only s3 is free to host.
        expect(schedule).toHaveLength(1);
    });

    test('a company with no Cvent appointment at a time can use every rep there', async () => {
        const a = [
            sponsor('s1', 'acct-a', { boothNo: '1', meetingsAtOnce: 3 }),
            sponsor('s2', 'acct-a', { boothNo: '1', meetingsAtOnce: 3 }),
            sponsor('s3', 'acct-a', { boothNo: '1', meetingsAtOnce: 3 }),
        ];
        const ds = delegates(3);

        const { schedule } = await run([...a, ...ds], requestsFrom('acct-a', ds), [isoSlot('b1', T9, 5)]);

        expect(schedule).toHaveLength(3);
    });

    test("a slot's room is Cvent's setting minus the appointments already at that location and time", async () => {
        const s = sponsor('s1', 'acct-a', { boothNo: '1', meetingsAtOnce: 2 });
        const s2 = sponsor('s2', 'acct-a', { boothNo: '1', meetingsAtOnce: 2 });
        const other = sponsor('x1', 'acct-x', { boothNo: '4' });
        const ds = delegates(3);
        const attendees = [s, s2, other, ...ds];
        // Booth 1 shows 2 per slot at 09:00, and 2 appointments are already there.
        // They belong to someone the portal doesn't know, so they block only the room.
        const preexisting = preexistingFromAppointments(
            [cventAppt(T9, ['h-stranger'], ['a-stranger']), cventAppt(T9, ['h-stranger-2'], ['a-stranger-2'])],
            attendees,
        );

        const full = await run(attendees, requestsFrom('acct-a', ds), [isoSlot('b1', T9, 2)], null, preexisting);
        expect(full.schedule).toHaveLength(0);

        const open = await run(attendees, requestsFrom('acct-a', ds), [isoSlot('b1', T9, 2)]);
        expect(open.schedule).toHaveLength(2);
    });

    test("without Cvent's appointment list, pushed meetings come off their timeslot's room", async () => {
        const a = [
            sponsor('s1', 'acct-a', { boothNo: '1', meetingsAtOnce: 2 }),
            sponsor('s2', 'acct-a', { boothNo: '1', meetingsAtOnce: 2 }),
        ];
        const ds = delegates(1);
        const timeslots = [isoSlot('b1', T9, 1)];

        const { schedule } = await run([...a, ...ds], requestsFrom('acct-a', ds), timeslots, null, {
            bookedByTimeslotId: new Map([[timeslots[0].id, 1]]),
        });

        expect(schedule).toHaveLength(0);
    });
});
