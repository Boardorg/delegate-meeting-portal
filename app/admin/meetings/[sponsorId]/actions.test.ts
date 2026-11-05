import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Attendee, Location, Timeslot } from "@/types";
import { emptyProfile } from "@/lib/attendees/formatProfile";

// ---------------------------------------------------------------------------
// The per-sponsor page: its meeting counts, and the slots the Edit and Create
// Meeting windows offer. The DB, attendee loader, Cvent and settings are mocked.
// ---------------------------------------------------------------------------

const loadAttendees = vi.fn();
const loadEventScheduleData = vi.fn();
const getEventSettings = vi.fn();

// Every query returns these rows. `.limit()` returns them too.
let rows: unknown[] = [];

/**
 * The result of a mocked `.where()`: awaitable, with a `.limit()` that gives the same rows.
 *
 * @returns {Promise<unknown[]> & { limit: () => Promise<unknown[]> }} The rows.
 */
function whereResult() {
    return Object.assign(Promise.resolve(rows), { limit: async () => rows });
}

const dbUpdate = vi.fn();
const dbInsert = vi.fn();

vi.mock("@/lib/db/client", () => ({
    db: {
        select: () => ({ from: () => ({ where: whereResult }) }),
        update: (...a: unknown[]) => {
            dbUpdate(...a);
            return { set: () => ({ where: async () => undefined }) };
        },
        insert: (...a: unknown[]) => {
            dbInsert(...a);
            return { values: async () => undefined };
        },
    },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/attendees/loader", () => ({
    loadAttendees: (...a: unknown[]) => loadAttendees(...a),
}));
vi.mock("@/lib/cvent/mapper", () => ({
    loadEventScheduleData: (...a: unknown[]) => loadEventScheduleData(...a),
}));
vi.mock("@/lib/events/settings", () => ({
    getEventSettings: (...a: unknown[]) => getEventSettings(...a),
}));
vi.mock("@/lib/cvent/client", () => ({
    getAppointmentsByEvent: async () => [],
    cancelAppointment: vi.fn(),
}));
vi.mock("@/lib/cvent/push", () => ({
    pushMeetingRows: vi.fn(),
    needsSync: vi.fn(),
}));

import {
    createMeeting,
    editMeeting,
    getMeetingDetail,
    getNewMeetingSlots,
    getSlotOptions,
} from "./actions";

/**
 * Builds a sponsor rep.
 *
 * @param {string} id - The rep's Salesforce id.
 * @param {string} accountId - The company.
 * @param {Partial<Attendee>} [partial] - Fields to set.
 * @returns {Attendee} The rep.
 */
function sponsor(id: string, accountId: string, partial: Partial<Attendee> = {}): Attendee {
    return {
        id,
        cventContactId: `cvent-${id}`,
        salesforceId: id,
        accountId,
        name: id,
        email: "",
        phone: "",
        role: "sponsor",
        company: accountId,
        title: "",
        sponsorTier: partial.sponsorTier ?? "standard",
        opportunityId: `opp-${accountId}`,
        boothNo: partial.boothNo ?? null,
        purchasedMeetings: partial.purchasedMeetings ?? null,
        bonusMeetings: partial.bonusMeetings ?? null,
        maximumMeetings: partial.maximumMeetings ?? null,
        meetingsAtOnce: null,
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: null, requestedSponsorAccountIds: [] },
    };
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

/**
 * Builds a sponsor slot at a location.
 *
 * @param {string} id - The slot id.
 * @param {string} startTime - ISO start time.
 * @param {string} locationId - The location.
 * @returns {Timeslot} The slot.
 */
function slot(id: string, startTime: string, locationId: string): Timeslot {
    return {
        id,
        day: 1,
        startTime,
        endTime: new Date(new Date(startTime).getTime() + 20 * 60_000).toISOString(),
        capacity: 1,
        locationId,
        appointmentTypeId: "t-s2d",
        appointmentTypeName: "Sponsor to Delegate Meetings",
        kind: "sponsor_delegate",
    };
}

const LOCATIONS = [loc("b2", "Booth 2"), loc("b3", "Booth 3"), loc("b4", "Booth 4"), loc("tbl", "Table 1A")];
const TIMESLOTS = [
    slot("b2-09", "2026-11-10T09:00:00.000Z", "b2"),
    slot("b4-09", "2026-11-10T09:00:00.000Z", "b4"),
    slot("tbl-09", "2026-11-10T09:00:00.000Z", "tbl"),
    slot("b3-10", "2026-11-10T10:00:00.000Z", "b3"),
    slot("b3-11", "2026-11-10T11:00:00.000Z", "b3"),
];

// The three NALES test sponsors, at Booths 2, 3 and 4.
const ATTENDEES = [
    sponsor("bob", "acct-21m", { boothNo: "2", maximumMeetings: 5 }),
    sponsor("ronnie", "acct-lake", { boothNo: "3", purchasedMeetings: 4, bonusMeetings: 1 }),
    sponsor("carolina", "acct-match", { boothNo: "4" }),
];

/**
 * A scheduled_meetings row for Lakeside.
 *
 * @param {string} timeslotId - The meeting's slot.
 * @param {string} locationId - The meeting's location.
 * @returns {Record<string, unknown>} The row.
 */
function lakesideMeeting(timeslotId: string, locationId: string) {
    return {
        id: "m1",
        eventCode: "NALES",
        attendeeA: "acct-lake",
        attendeeB: "d1",
        day: 1,
        timeslotId,
        passNumber: 1,
        mutual: false,
        matchKind: "sponsor_choice",
        rank: 5,
        source: "portal",
        locationId,
        cventAppointmentId: null,
        lastModifiedAt: null,
        lastPushedAt: null,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    rows = [];
    loadAttendees.mockResolvedValue(ATTENDEES);
    getEventSettings.mockResolvedValue({ boothLocations: null });
    loadEventScheduleData.mockResolvedValue({
        timeslots: TIMESLOTS,
        locations: LOCATIONS,
        timeslotById: new Map(TIMESLOTS.map((t) => [t.id, t])),
        locationById: new Map(LOCATIONS.map((l) => [l.id, l])),
        timezone: "UTC",
    });
});

describe("getMeetingDetail — Salesforce meeting counts", () => {
    test("shows purchased, bonus and maximum from Salesforce", async () => {
        const detail = await getMeetingDetail({ sponsorId: "acct-lake", eventCode: "NALES" });
        expect(detail?.sponsor).toMatchObject({ purchased: 4, bonus: 1, maximum: 5, maximumFromTier: false });
    });

    test("uses the tier fallback when all three are blank", async () => {
        loadAttendees.mockResolvedValue([sponsor("d", "acct-dia", { sponsorTier: "diamond" })]);
        const detail = await getMeetingDetail({ sponsorId: "acct-dia", eventCode: "NALES" });
        expect(detail?.sponsor).toMatchObject({ purchased: null, bonus: null, maximum: 8, maximumFromTier: true });
    });
});

describe("Edit and Create Meeting slots — booths", () => {
    test("Create offers Lakeside's own booth first and never another company's booth", async () => {
        const { options } = await getNewMeetingSlots({ sponsorId: "acct-lake", delegateId: "d1", eventCode: "NALES" });

        expect(options.map((o) => o.timeslotId)).toEqual(["b3-10", "b3-11", "tbl-09"]);
    });

    test("Edit offers Lakeside's own booth first and never another company's booth", async () => {
        rows = [lakesideMeeting("b3-10", "b3")];

        const { current, options } = await getSlotOptions({ meetingId: "m1", eventCode: "NALES" });

        expect(current?.timeslotId).toBe("b3-10");
        expect(options[0].ownBooth).toBe(true);
        expect(options.map((o) => o.locationId)).not.toContain("b2");
        expect(options.map((o) => o.locationId)).not.toContain("b4");
    });

    test("Edit doesn't offer the current slot when it is at another company's booth", async () => {
        rows = [lakesideMeeting("b2-09", "b2")];

        const { options } = await getSlotOptions({ meetingId: "m1", eventCode: "NALES" });

        expect(options.map((o) => o.timeslotId)).not.toContain("b2-09");
    });

    test("a manual mapping moves the sponsor's own booth", async () => {
        // Lakeside's booth number 3 is mapped to Table 1A, so Booth 3 is no one's booth now.
        getEventSettings.mockResolvedValue({ boothLocations: { "3": "tbl" } });

        const { options } = await getNewMeetingSlots({ sponsorId: "acct-lake", delegateId: "d1", eventCode: "NALES" });

        expect(options[0]).toMatchObject({ timeslotId: "tbl-09", ownBooth: true });
        expect(options.map((o) => o.locationId)).not.toContain("b2");
    });
});

describe("Edit and Create Meeting saves — the server refuses another company's booth", () => {
    /**
     * Creates a Lakeside meeting with d1 in one slot.
     *
     * @param {string} timeslotId - The slot.
     * @param {string} locationId - The location sent with it.
     * @returns The save result.
     */
    const create = (timeslotId: string, locationId: string) =>
        createMeeting({ eventCode: "NALES", sponsorId: "acct-lake", delegateId: "d1", timeslotId, day: 1, locationId });

    test("Create returns an error and saves nothing for a slot at another company's booth", async () => {
        const result = await create("b2-09", "b2");

        expect(result.ok).toBe(false);
        expect(!result.ok && result.error).toContain("Booth 2");
        expect(dbInsert).not.toHaveBeenCalled();
    });

    test("Create refuses another company's booth even when the location sent with the slot is changed", async () => {
        const result = await create("b4-09", "tbl");

        expect(result.ok).toBe(false);
        expect(dbInsert).not.toHaveBeenCalled();
    });

    test("Create saves a slot at the sponsor's own booth, or at a location that is no one's booth", async () => {
        expect(await create("b3-10", "b3")).toEqual({ ok: true });
        expect(await create("tbl-09", "tbl")).toEqual({ ok: true });
        expect(dbInsert).toHaveBeenCalledTimes(2);
    });

    test("Edit returns an error and saves nothing for a slot at another company's booth", async () => {
        rows = [lakesideMeeting("b3-10", "b3")];

        const result = await editMeeting({ id: "m1", timeslotId: "b4-09", day: 1, locationId: "b4" });

        expect(result.ok).toBe(false);
        expect(dbUpdate).not.toHaveBeenCalled();
    });

    test("Edit saves a move within the sponsor's own booth", async () => {
        rows = [lakesideMeeting("b3-10", "b3")];

        expect(await editMeeting({ id: "m1", timeslotId: "b3-11", day: 1, locationId: "b3" })).toEqual({ ok: true });
        expect(dbUpdate).toHaveBeenCalledTimes(1);
    });

    test("refuses a save into another company's booth when no attendees loaded, as when Cvent's attendee lookup fails", async () => {
        loadAttendees.mockResolvedValue([]);

        const result = await create("b2-09", "b2");

        expect(result.ok).toBe(false);
        expect(dbInsert).not.toHaveBeenCalled();
    });

    test("refuses the save when Cvent returned no locations", async () => {
        loadEventScheduleData.mockResolvedValue({
            timeslots: [],
            locations: [],
            timeslotById: new Map(),
            locationById: new Map(),
            timezone: "UTC",
        });

        const result = await create("b2-09", "b2");

        expect(result.ok).toBe(false);
        expect(dbInsert).not.toHaveBeenCalled();
    });

    test("returns an error instead of throwing when loading the attendees fails", async () => {
        loadAttendees.mockRejectedValue(new Error("Salesforce down"));

        const created = await create("b3-10", "b3");
        rows = [lakesideMeeting("b3-10", "b3")];
        const edited = await editMeeting({ id: "m1", timeslotId: "b3-11", day: 1, locationId: "b3" });

        expect(created.ok).toBe(false);
        expect(edited.ok).toBe(false);
        expect(dbInsert).not.toHaveBeenCalled();
        expect(dbUpdate).not.toHaveBeenCalled();
    });

    test("refuses the save when the booths can't be checked", async () => {
        getEventSettings.mockRejectedValue(new Error("db down"));

        const result = await create("b3-10", "b3");

        expect(result.ok).toBe(false);
        expect(dbInsert).not.toHaveBeenCalled();
    });
});
