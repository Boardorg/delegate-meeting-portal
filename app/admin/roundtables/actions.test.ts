import { describe, test, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Attendee, Timeslot } from "@/types";
import type { NewRoundtable, NewRoundtableSeat, RoundtableRow } from "@/lib/db/schema";
import type { MatchingContext } from "@/lib/matching/data";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { DEFAULT_MATCHING_SETTINGS } from "@/lib/matching/settings";

// ---------------------------------------------------------------------------
// runRoundtablesForEvent. The matching data and the DB are mocked.
// ---------------------------------------------------------------------------

const loadMatchingContext = vi.fn();
const deleteWhere = vi.fn<(cond: SQL) => Promise<void>>(async () => undefined);
const inserted: unknown[] = [];

vi.mock("@/lib/matching/data", () => ({
    loadMatchingContext: (...a: unknown[]) => loadMatchingContext(...a),
}));
vi.mock("@/lib/db/client", () => ({
    db: {
        delete: () => ({ where: (cond: SQL) => deleteWhere(cond) }),
        insert: () => ({ values: async (rows: unknown) => void inserted.push(rows) }),
    },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { runRoundtablesForEvent } from "./actions";

/**
 * Builds a delegate with no meetings.
 *
 * @param {string} id - The Salesforce id.
 * @returns {Attendee} The delegate.
 */
function delegate(id: string): Attendee {
    return {
        id,
        cventContactId: `c-${id}`,
        salesforceId: id,
        accountId: `acct-${id}`,
        name: id,
        email: "",
        phone: "",
        role: "delegate",
        company: `Co ${id}`,
        title: "",
        sponsorTier: null,
        profile: { ...emptyProfile(), meetingInterests: ["Leadership Development"] },
        scheduling: { maxSameCompanyMeetings: 2, requestedSponsorAccountIds: [] },
    };
}

/**
 * Builds a delegate_group table slot.
 *
 * @param {string} id - The timeslot id.
 * @returns {Timeslot} The slot.
 */
function slot(id: string): Timeslot {
    const start = "2027-01-20T15:00:00.000Z";
    return { id, day: 1, startTime: start, endTime: start, capacity: 1, locationId: `loc-${id}`, appointmentTypeId: "g", appointmentTypeName: "Group", kind: "delegate_group" };
}

/**
 * Builds a roundtable row.
 *
 * @param {string} id - The roundtable id.
 * @param {string} timeslotId - Its slot.
 * @param {string | null} cventAppointmentId - Its Cvent appointment, when pushed.
 * @returns {RoundtableRow} The row.
 */
function table(id: string, timeslotId: string, cventAppointmentId: string | null): RoundtableRow {
    return { id, eventCode: "EVT", timeslotId, locationId: null, themeTitle: "Old", description: null, cventAppointmentId, lastModifiedAt: null, lastPushedAt: null, createdAt: new Date(0) };
}

beforeEach(() => {
    vi.clearAllMocks();
    inserted.length = 0;
});

describe("runRoundtablesForEvent", () => {
    test("replaces unpushed roundtables and leaves pushed ones and their delegates alone", async () => {
        const slots = [slot("a"), slot("b")];
        const attendees = ["d1", "d2", "d3", "d4", "d5"].map(delegate);
        const ctx: MatchingContext = {
            attendees,
            scheduleData: {
                timeslots: slots,
                locations: [],
                timeslotById: new Map(slots.map((s) => [s.id, s])),
                locationById: new Map(),
                timezone: "UTC",
                appointmentTypes: [],
                appointmentTypeKinds: null,
            },
            settings: DEFAULT_MATCHING_SETTINGS,
            rows: [],
            roundtableRows: [table("rt-pushed", "a", "appt-1"), table("rt-old", "b", null)],
            seatRows: [
                { id: 1, eventCode: "EVT", roundtableId: "rt-pushed", delegateId: "d1", role: "seated", position: 1, reason: null, score: null, createdAt: new Date(0) },
            ],
            appointments: [],
            cventOnly: [],
            counts: new Map(),
        };
        loadMatchingContext.mockResolvedValue(ctx);

        const result = await runRoundtablesForEvent("EVT");

        expect(result.ok).toBe(true);
        // Seats of the unpushed table go, then the unpushed tables themselves.
        const dialect = new PgDialect();
        const seatDelete = dialect.sqlToQuery(deleteWhere.mock.calls[0][0]);
        expect(seatDelete.params).toEqual(["rt-old"]);
        expect(dialect.sqlToQuery(deleteWhere.mock.calls[1][0]).sql).toContain('"cvent_appointment_id" is null');

        // Only slot b gets a new table, and d1 at the pushed table isn't seated again.
        const [tables, seats] = inserted as [NewRoundtable[], NewRoundtableSeat[]];
        expect(tables.map((t) => t.timeslotId)).toEqual(["b"]);
        expect(tables[0].themeTitle).toBeNull();
        expect(seats.map((s) => s.delegateId)).not.toContain("d1");
        expect(seats.filter((s) => s.role === "seated")).toHaveLength(4);
    });
});
