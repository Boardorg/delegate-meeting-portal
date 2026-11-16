import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Attendee, Timeslot } from "@/types";
import type { RoundtableRow, RoundtableSeatRow } from "@/lib/db/schema";
import type { MatchingContext } from "@/lib/matching/data";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { DEFAULT_MATCHING_SETTINGS } from "@/lib/matching/settings";

// ---------------------------------------------------------------------------
// Moving delegates between roundtables. The matching data and the DB are mocked.
// ---------------------------------------------------------------------------

const loadMatchingContext = vi.fn();
const dbUpdate = vi.fn();
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
                set: () => ({ where: () => ({ returning: async () => [{ id: "rt-1" }] }) }),
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

import { moveDelegate, saveRoundtableText } from "./actions";

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
        cventOnly: [],
        counts: new Map(),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
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

    test("refuses a theme that is too long, with a message", async () => {
        const result = await saveRoundtableText({ roundtableId: "rt-1", themeTitle: "x".repeat(201), description: "" });
        expect(result.ok).toBe(false);
        expect(dbUpdate).not.toHaveBeenCalled();
    });
});
