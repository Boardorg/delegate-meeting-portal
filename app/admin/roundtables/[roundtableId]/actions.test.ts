import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Attendee, Timeslot } from "@/types";
import type { RoundtableRow, RoundtableSeatRow } from "@/lib/db/schema";
import type { MatchingContext } from "@/lib/matching/data";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { DEFAULT_MATCHING_SETTINGS } from "@/lib/matching/settings";
import { DEFAULT_ROUNDTABLE_DESCRIPTION } from "@/lib/matching/roundtables";
import { getSyncStatus } from "@/lib/cvent/syncStatus";

// ---------------------------------------------------------------------------
// Moving delegates between roundtables. The matching data and the DB are mocked.
// ---------------------------------------------------------------------------

const loadMatchingContext = vi.fn();
const dbUpdate = vi.fn();
const dbSet = vi.fn();
const dbInsert = vi.fn();
const dbDelete = vi.fn();

vi.mock("@/lib/matching/data", () => ({
    loadMatchingContext: (...a: unknown[]) => loadMatchingContext(...a),
}));
vi.mock("@/lib/db/client", () => ({
    db: {
        update: (...a: unknown[]) => {
            dbUpdate(...a);
            return {
                set: (values: unknown) => {
                    dbSet(values);
                    return { where: () => ({ returning: async () => [{ id: "rt-1" }] }) };
                },
            };
        },
        insert: (...a: unknown[]) => {
            dbInsert(...a);
            return { values: async () => undefined };
        },
        delete: (...a: unknown[]) => {
            dbDelete(...a);
            return { where: async () => undefined };
        },
        select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }),
    },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getRoundtableDetail, moveDelegate, saveRoundtableText } from "./actions";
import { storedSlotMap } from "@/lib/cvent/storedSlots";

/**
 * Builds a delegate with no meetings.
 *
 * @param {string} id - The Salesforce id.
 * @param {string} company - The company name, also used for the Account id.
 * @returns {Attendee} The delegate.
 */
function delegate(id: string, company: string): Attendee {
    return {
        id,
        cventContactId: `c-${id}`,
        salesforceId: id,
        accountId: `acct-${company}`,
        name: id,
        email: "",
        phone: "",
        role: "delegate",
        company,
        title: "",
        sponsorTier: null,
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: 2, requestedSponsorAccountIds: [] },
    };
}

const SLOT: Timeslot = {
    id: "ts-rt",
    day: 1,
    startTime: "2027-01-20T15:00:00.000Z",
    endTime: "2027-01-20T15:40:00.000Z",
    capacity: 1,
    locationId: "loc-rt",
    appointmentTypeId: "g",
    appointmentTypeName: "Group",
    kind: "delegate_group",
};

const TABLE: RoundtableRow = {
    id: "rt-1",
    eventCode: "EVT",
    timeslotId: "ts-rt",
    locationId: "loc-rt",
    themeTitle: null,
    description: null,
    cventAppointmentId: null,
    lastModifiedAt: null,
    lastPushedAt: null,
    createdAt: new Date(0),
};

/**
 * Builds a seat at rt-1.
 *
 * @param {string} delegateId - The delegate.
 * @param {number} id - The seat row id.
 * @returns {RoundtableSeatRow} The seat.
 */
function seat(delegateId: string, id: number): RoundtableSeatRow {
    return { id, eventCode: "EVT", roundtableId: "rt-1", delegateId, role: "seated", position: id, reason: null, score: null, createdAt: new Date(0) };
}

/**
 * Builds the matching data with Acme's Ann seated at rt-1.
 *
 * @param {Attendee[]} attendees - The event's delegates.
 * @returns {MatchingContext} The data.
 */
function context(attendees: Attendee[]): MatchingContext {
    return {
        attendees,
        scheduleData: {
            timeslots: [SLOT],
            locations: [],
            timeslotById: new Map([[SLOT.id, SLOT]]),
            locationById: new Map(),
            timezone: "UTC",
            appointmentTypes: [],
            appointmentTypeKinds: null,
        },
        settings: DEFAULT_MATCHING_SETTINGS,
        rows: [],
        roundtableRows: [TABLE],
        seatRows: [seat("ann", 1)],
        appointments: [],
        slotById: new Map([[SLOT.id, SLOT]]),
        cventOnly: [],
        counts: new Map(),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

/**
 * The sync status a table pushed a day ago would have after the first saved change.
 * It reads lastModifiedAt from the first db set() call.
 *
 * @returns {string} The sync status.
 */
function statusOfPushedTableAfterSave(): string {
    const { lastModifiedAt } = dbSet.mock.calls[0][0] as { lastModifiedAt: Date };
    return getSyncStatus({
        cventAppointmentId: "appt-1",
        lastPushedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        lastModifiedAt,
    });
}

describe("getRoundtableDetail", () => {
    test("shows a pushed table's day and time from its Cvent appointment when Cvent no longer lists its slot", async () => {
        // Table 1 allows one appointment at a time, so its booked slot dropped out of the list.
        // Another time at the same location is still listed.
        const later: Timeslot = { ...SLOT, id: "ts-later", startTime: "2027-01-20T16:00:00.000Z", endTime: "2027-01-20T16:40:00.000Z" };
        const ctx = context([delegate("ann", "Acme")]);
        ctx.scheduleData.timeslots = [later];
        ctx.scheduleData.timeslotById = new Map([[later.id, later]]);
        ctx.roundtableRows = [{ ...TABLE, cventAppointmentId: "appt-1", lastPushedAt: new Date(0) }];
        ctx.appointments = [
            {
                id: "appt-1",
                startTime: SLOT.startTime,
                endTime: SLOT.endTime,
                participantContactIds: ["c-ann"],
                hostContactIds: ["c-ann"],
                locationName: null,
                locationId: null,
                typeName: "Group",
                typeId: null,
            },
        ];
        ctx.slotById = storedSlotMap(ctx.scheduleData, ctx.roundtableRows, ctx.appointments);
        loadMatchingContext.mockResolvedValue(ctx);

        const detail = await getRoundtableDetail({ roundtableId: "rt-1", eventCode: "EVT" });

        expect(detail?.table.startTime).toBe(SLOT.startTime);
        expect(detail?.table.day).toBe(1);
    });
});

describe("moveDelegate", () => {
    test("criterion 18: moving a delegate onto a table that has someone from their company is refused with a message", async () => {
        loadMatchingContext.mockResolvedValue(context([delegate("ann", "Acme"), delegate("bob", "Acme")]));

        const result = await moveDelegate({ eventCode: "EVT", delegateId: "bob", to: { roundtableId: "rt-1", role: "seated" } });

        expect(result).toEqual({ ok: false, error: "Error: bob can't sit here. ann at this table is also from Acme." });
        expect(dbInsert).not.toHaveBeenCalled();
        expect(dbUpdate).not.toHaveBeenCalled();
    });

    test("seats a delegate from another company and marks the table edited", async () => {
        loadMatchingContext.mockResolvedValue(context([delegate("ann", "Acme"), delegate("cat", "Globex")]));

        const result = await moveDelegate({ eventCode: "EVT", delegateId: "cat", to: { roundtableId: "rt-1", role: "seated" } });

        expect(result).toEqual({ ok: true });
        expect(dbInsert).toHaveBeenCalledTimes(1);
        expect(dbUpdate).toHaveBeenCalledTimes(1);
    });

    test("criterion 20: moving the host off a pushed table marks it Modified, so the next push updates Cvent", async () => {
        loadMatchingContext.mockResolvedValue(context([delegate("ann", "Acme")]));

        const result = await moveDelegate({ eventCode: "EVT", delegateId: "ann", to: null });

        expect(result).toEqual({ ok: true });
        expect(dbDelete).toHaveBeenCalledTimes(1);
        expect(statusOfPushedTableAfterSave()).toBe("modified");
    });

    test("finding 2: a delegate seated at pushed table A can move to table B at the same time", async () => {
        const ctx = context([delegate("ann", "Acme")]);
        const slotB: Timeslot = { ...SLOT, id: "ts-rt-b", locationId: "loc-rt-b" };
        ctx.scheduleData.timeslots = [SLOT, slotB];
        ctx.scheduleData.timeslotById = new Map([[SLOT.id, SLOT], [slotB.id, slotB]]);
        ctx.slotById = new Map(ctx.scheduleData.timeslotById);
        ctx.roundtableRows = [
            { ...TABLE, cventAppointmentId: "appt-A", lastPushedAt: new Date(0) },
            { ...TABLE, id: "rt-2", timeslotId: slotB.id, locationId: "loc-rt-b" },
        ];
        // Table A's own appointment lists ann, but the portal's seats are the truth for roundtables.
        ctx.appointments = [
            { id: "appt-A", startTime: SLOT.startTime, participantContactIds: ["c-ann"], hostContactIds: ["c-ann"], locationName: null },
        ] as MatchingContext["appointments"];
        loadMatchingContext.mockResolvedValue(ctx);

        const result = await moveDelegate({ eventCode: "EVT", delegateId: "ann", to: { roundtableId: "rt-2", role: "seated" } });

        expect(result).toEqual({ ok: true });
    });

    test("asks for confirmation before seating a delegate who now has a meeting", async () => {
        const ctx = context([delegate("ann", "Acme"), delegate("dan", "Initech")]);
        ctx.counts = new Map([["dan", { s2d: 1, d2d: 0 }]]);
        loadMatchingContext.mockResolvedValue(ctx);

        const first = await moveDelegate({ eventCode: "EVT", delegateId: "dan", to: { roundtableId: "rt-1", role: "seated" } });
        expect(first).toMatchObject({ ok: false, needsConfirm: true });
        expect(dbInsert).not.toHaveBeenCalled();

        const confirmed = await moveDelegate({
            eventCode: "EVT",
            delegateId: "dan",
            to: { roundtableId: "rt-1", role: "seated" },
            confirmed: true,
        });
        expect(confirmed).toEqual({ ok: true });
        expect(dbInsert).toHaveBeenCalledTimes(1);
    });
});

describe("saveRoundtableText", () => {
    test("saves the trimmed theme and description and marks the table edited", async () => {
        const result = await saveRoundtableText({ roundtableId: "rt-1", themeTitle: "  Skills  ", description: "" });
        expect(result).toEqual({ ok: true });
        expect(dbUpdate).toHaveBeenCalledTimes(1);
    });

    test("criterion 20: changing a pushed table's theme marks it Modified", async () => {
        const result = await saveRoundtableText({ roundtableId: "rt-1", themeTitle: "Board Readiness", description: DEFAULT_ROUNDTABLE_DESCRIPTION });

        expect(result).toEqual({ ok: true });
        expect(dbSet.mock.calls[0][0]).toMatchObject({ themeTitle: "Board Readiness" });
        expect(statusOfPushedTableAfterSave()).toBe("modified");
    });

    test("criterion 21a: editing a pushed table's description marks it Modified and saves the text as typed", async () => {
        const text = `${DEFAULT_ROUNDTABLE_DESCRIPTION}\n\nWhat does good leadership look like?`;

        await saveRoundtableText({ roundtableId: "rt-1", themeTitle: "Skills", description: text });

        expect(dbSet.mock.calls[0][0]).toMatchObject({ description: text });
        expect(statusOfPushedTableAfterSave()).toBe("modified");
    });

    test("criterion 21a: clearing the description stores it empty, not as the default, and marks a pushed table Modified", async () => {
        await saveRoundtableText({ roundtableId: "rt-1", themeTitle: "Skills", description: "   " });

        expect(dbSet.mock.calls[0][0]).toMatchObject({ description: "" });
        expect(statusOfPushedTableAfterSave()).toBe("modified");
    });

    test("criterion 21a: saving the default description stores it exactly", async () => {
        await saveRoundtableText({ roundtableId: "rt-1", themeTitle: "Skills", description: DEFAULT_ROUNDTABLE_DESCRIPTION });

        expect(dbSet.mock.calls[0][0]).toMatchObject({ description: DEFAULT_ROUNDTABLE_DESCRIPTION });
    });

    test("refuses a description that is too long, with a message", async () => {
        const result = await saveRoundtableText({ roundtableId: "rt-1", themeTitle: "Skills", description: "x".repeat(2001) });

        expect(result).toEqual({ ok: false, error: "Error: the description must be 2,000 characters or fewer" });
        expect(dbUpdate).not.toHaveBeenCalled();
    });

    test("refuses a theme that is too long, with a message", async () => {
        const result = await saveRoundtableText({ roundtableId: "rt-1", themeTitle: "x".repeat(201), description: "" });
        expect(result.ok).toBe(false);
        expect(dbUpdate).not.toHaveBeenCalled();
    });
});
