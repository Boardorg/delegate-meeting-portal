import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Attendee, Timeslot } from "@/types";
import type { RoundtableRow, RoundtableSeatRow } from "@/lib/db/schema";
import type { CventAppointmentInput } from "@/lib/cvent/client";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { DEFAULT_ROUNDTABLE_DESCRIPTION } from "@/lib/matching/roundtables";

// ---------------------------------------------------------------------------
// Pushing and unpushing roundtables.
// The DB, the Cvent client and the loaders are mocked, so these check what would be sent to Cvent.
// ---------------------------------------------------------------------------

const createAppointment = vi.fn();
const updateAppointment = vi.fn();
const cancelAppointment = vi.fn();
const getAppointmentsByEvent = vi.fn();
const getEventAppointments = vi.fn();
const loadAttendees = vi.fn();
const loadEventScheduleData = vi.fn();
// Every set() the push or unpush saves, in order.
const saved: Record<string, unknown>[] = [];

vi.mock("@/lib/cvent/client", () => ({
    createAppointment: (...a: unknown[]) => createAppointment(...a),
    updateAppointment: (...a: unknown[]) => updateAppointment(...a),
    cancelAppointment: (...a: unknown[]) => cancelAppointment(...a),
    getAppointmentsByEvent: (...a: unknown[]) => getAppointmentsByEvent(...a),
    getEventAppointments: (...a: unknown[]) => getEventAppointments(...a),
}));
vi.mock("@/lib/attendees/loader", () => ({
    loadAttendees: (...a: unknown[]) => loadAttendees(...a),
}));
vi.mock("@/lib/cvent/mapper", () => ({
    loadEventScheduleData: (...a: unknown[]) => loadEventScheduleData(...a),
}));
vi.mock("@/lib/db/client", () => ({
    db: {
        update: () => ({
            set: (values: Record<string, unknown>) => {
                saved.push(values);
                return { where: async () => undefined };
            },
        }),
    },
}));

import { pushRoundtableRows, unpushRoundtableRows } from "./roundtablePush";

const SLOT: Timeslot = {
    id: "ts-rt",
    day: 1,
    startTime: "2027-01-20T15:00:00.000Z",
    endTime: "2027-01-20T15:40:00.000Z",
    capacity: 1,
    locationId: "loc-rt",
    appointmentTypeId: "type-group",
    appointmentTypeName: "Delegate Group Meetings",
    kind: "delegate_group",
};

/**
 * Builds a delegate linked in Cvent.
 *
 * @param {string} id - The Salesforce id. The Cvent contact id is "c-" plus this.
 * @param {Partial<Attendee>} [overrides] - Fields to change.
 * @returns {Attendee} The delegate.
 */
function delegate(id: string, overrides: Partial<Attendee> = {}): Attendee {
    return {
        id,
        cventContactId: `c-${id}`,
        salesforceId: id,
        accountId: `acct-${id}`,
        name: `Name ${id}`,
        email: "",
        phone: "",
        role: "delegate",
        company: `Co ${id}`,
        title: "",
        sponsorTier: null,
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: 2, requestedSponsorAccountIds: [] },
        ...overrides,
    };
}

/**
 * Builds a roundtable row with a theme and the default description, not yet pushed.
 *
 * @param {Partial<RoundtableRow>} [overrides] - Fields to change.
 * @returns {RoundtableRow} The row.
 */
function table(overrides: Partial<RoundtableRow> = {}): RoundtableRow {
    return {
        id: "rt-001-1",
        eventCode: "EVT",
        timeslotId: "ts-rt",
        locationId: "loc-rt",
        themeTitle: "Leadership Development",
        description: DEFAULT_ROUNDTABLE_DESCRIPTION,
        cventAppointmentId: null,
        lastModifiedAt: null,
        lastPushedAt: null,
        createdAt: new Date(0),
        ...overrides,
    };
}

/**
 * Builds a seat at rt-001-1.
 *
 * @param {string} delegateId - The delegate.
 * @param {RoundtableSeatRow["role"]} role - Seated or alternate.
 * @param {number} position - The order within the role.
 * @returns {RoundtableSeatRow} The seat.
 */
function seat(delegateId: string, role: RoundtableSeatRow["role"], position: number): RoundtableSeatRow {
    return { id: position + (role === "alternate" ? 100 : 0), eventCode: "EVT", roundtableId: "rt-001-1", delegateId, role, position, reason: null, score: null, createdAt: new Date(0) };
}

/**
 * The seats used by most tests: three seated, in an order that doesn't start with the lowest id, and two alternates.
 *
 * @returns {RoundtableSeatRow[]} The seats.
 */
function defaultSeats(): RoundtableSeatRow[] {
    return [
        seat("sf-c", "seated", 1),
        seat("sf-a", "seated", 2),
        seat("sf-b", "seated", 3),
        seat("sf-alt1", "alternate", 1),
        seat("sf-alt2", "alternate", 2),
    ];
}

/**
 * Reads the appointment input of the first create.
 *
 * @returns {CventAppointmentInput} The input.
 */
function created(): CventAppointmentInput {
    return createAppointment.mock.calls[0][1];
}

/**
 * Reads the appointment input of the first in-place update.
 *
 * @returns {CventAppointmentInput} The input.
 */
function updated(): CventAppointmentInput {
    return updateAppointment.mock.calls[0][2];
}

beforeEach(() => {
    vi.clearAllMocks();
    saved.length = 0;
    createAppointment.mockResolvedValue("appt-new");
    updateAppointment.mockImplementation(async (_e: string, id: string) => id);
    getEventAppointments.mockResolvedValue([]);
    getAppointmentsByEvent.mockResolvedValue([]);
    loadEventScheduleData.mockResolvedValue({
        timeslotById: new Map([[SLOT.id, SLOT]]),
        locationById: new Map([["loc-rt", { id: "loc-rt", name: "Table 1" }]]),
    });
    loadAttendees.mockResolvedValue(["sf-a", "sf-b", "sf-c", "sf-alt1", "sf-alt2"].map((id) => delegate(id)));
});

describe("pushRoundtableRows", () => {
    test("criterion 19: sends the theme as subject, the description, the lowest Salesforce id as host and the others as attendees, never alternates", async () => {
        const summary = await pushRoundtableRows("EVT", [table()], defaultSeats());

        expect(summary).toMatchObject({ total: 1, pushed: 1, failed: 0 });
        const input = created();
        expect(input.subject).toBe("Leadership Development");
        expect(input.description).toBe(DEFAULT_ROUNDTABLE_DESCRIPTION);
        expect(input.hostContactIds).toEqual(["c-sf-a"]);
        expect(input.attendeeContactIds).toEqual(["c-sf-c", "c-sf-b"]);
        expect(JSON.stringify(input)).not.toContain("alt");
        expect(input.appointmentTypeId).toBe("type-group");
        expect(input.locationId).toBe("loc-rt");
        expect(input.code).toBe("rt-001-1");
        expect(saved[0]).toMatchObject({ cventAppointmentId: "appt-new" });
        expect(saved[0].lastPushedAt).toBeInstanceOf(Date);
    });

    test("criterion 20: re-pushing a modified table updates the same Cvent appointment in place", async () => {
        const modified = table({
            themeTitle: "Board Readiness",
            cventAppointmentId: "appt-1",
            lastPushedAt: new Date("2027-01-01T00:00:00Z"),
            lastModifiedAt: new Date("2027-01-02T00:00:00Z"),
        });

        const summary = await pushRoundtableRows("EVT", [modified], defaultSeats());

        expect(summary.results[0]).toMatchObject({ ok: true, kind: "update", cventAppointmentId: "appt-1" });
        expect(createAppointment).not.toHaveBeenCalled();
        expect(cancelAppointment).not.toHaveBeenCalled();
        expect(updateAppointment.mock.calls[0][0]).toBe("EVT");
        expect(updateAppointment.mock.calls[0][1]).toBe("appt-1");
        expect(updated().subject).toBe("Board Readiness");
        expect(saved[0]).toMatchObject({ cventAppointmentId: "appt-1" });
    });

    test("criterion 20: after the host is moved off, the next lowest id hosts and the same appointment is updated", async () => {
        const modified = table({
            cventAppointmentId: "appt-1",
            lastPushedAt: new Date("2027-01-01T00:00:00Z"),
            lastModifiedAt: new Date("2027-01-02T00:00:00Z"),
        });
        const withoutHost = defaultSeats().filter((s) => s.delegateId !== "sf-a");

        await pushRoundtableRows("EVT", [modified], withoutHost);

        expect(updateAppointment.mock.calls[0][1]).toBe("appt-1");
        expect(updated().hostContactIds).toEqual(["c-sf-b"]);
        expect(updated().attendeeContactIds).toEqual(["c-sf-c"]);
    });

    test("criterion 20: the table's own appointment doesn't count as making its host busy", async () => {
        getEventAppointments.mockResolvedValue([
            { id: "appt-1", startTime: SLOT.startTime, participantContactIds: ["c-sf-a"], hostContactIds: ["c-sf-a"], locationName: null },
        ]);
        const pushed = table({
            cventAppointmentId: "appt-1",
            lastPushedAt: new Date("2027-01-01T00:00:00Z"),
            lastModifiedAt: new Date("2027-01-02T00:00:00Z"),
        });

        const summary = await pushRoundtableRows("EVT", [pushed], defaultSeats());

        expect(summary.pushed).toBe(1);
    });

    test("criterion 21: refuses a table with no theme title, with a message, and sends nothing", async () => {
        const summary = await pushRoundtableRows("EVT", [table({ themeTitle: null }), table({ id: "rt-2", themeTitle: "   " })], defaultSeats());

        expect(summary).toMatchObject({ total: 2, pushed: 0, failed: 2 });
        expect(summary.results[0]).toMatchObject({ ok: false, reason: "missing_theme" });
        expect(summary.results[0].error).toBe("Table 1 has no theme title. Enter one on the table's page, then push again.");
        expect(summary.results[1].reason).toBe("missing_theme");
        expect(createAppointment).not.toHaveBeenCalled();
        expect(updateAppointment).not.toHaveBeenCalled();
        expect(saved).toHaveLength(0);
    });

    test("criterion 21: a table without a theme doesn't stop the others in the batch", async () => {
        const summary = await pushRoundtableRows("EVT", [table({ id: "rt-x", themeTitle: null }), table()], defaultSeats());

        expect(summary).toMatchObject({ total: 2, pushed: 1, failed: 1 });
    });

    test("criterion 21a: a cleared description is pushed empty, not as the default", async () => {
        await pushRoundtableRows("EVT", [table({ description: "" })], defaultSeats());

        expect(created().description).toBe("");
    });

    test("criterion 21a: a description stored as null is pushed empty", async () => {
        await pushRoundtableRows("EVT", [table({ description: null })], defaultSeats());

        expect(created().description).toBe("");
    });

    test("criterion 21a: an edited description is pushed exactly, and re-pushed in place", async () => {
        const text = `${DEFAULT_ROUNDTABLE_DESCRIPTION}\n\nWhat does good leadership look like in 2027?`;
        const modified = table({
            description: text,
            cventAppointmentId: "appt-1",
            lastPushedAt: new Date("2027-01-01T00:00:00Z"),
            lastModifiedAt: new Date("2027-01-02T00:00:00Z"),
        });

        await pushRoundtableRows("EVT", [modified], defaultSeats());

        expect(updated().description).toBe(text);
    });

    test("fails without calling Cvent when the host already hosts another appointment then", async () => {
        getEventAppointments.mockResolvedValue([
            { id: "other", startTime: SLOT.startTime, participantContactIds: ["c-sf-a"], hostContactIds: ["c-sf-a"], locationName: null },
        ]);

        const summary = await pushRoundtableRows("EVT", [table()], defaultSeats());

        expect(summary.results[0]).toMatchObject({ ok: false, reason: "host_not_in_cvent" });
        expect(summary.results[0].error).toContain("already hosts another Cvent appointment at this time");
        expect(createAppointment).not.toHaveBeenCalled();
    });

    test("refuses a table with no location, since Cvent needs one", async () => {
        const summary = await pushRoundtableRows("EVT", [table({ locationId: null })], defaultSeats());

        expect(summary.results[0].reason).toBe("missing_location");
        expect(createAppointment).not.toHaveBeenCalled();
    });

    test("refuses a table with no one seated, since it has no host", async () => {
        const alternatesOnly = defaultSeats().filter((s) => s.role === "alternate");

        const summary = await pushRoundtableRows("EVT", [table()], alternatesOnly);

        expect(summary.results[0].reason).toBe("empty_table");
        expect(createAppointment).not.toHaveBeenCalled();
    });

    test("refuses a table with a seated delegate who cancelled in Cvent", async () => {
        loadAttendees.mockResolvedValue([delegate("sf-a"), delegate("sf-b", { cventCancelled: true }), delegate("sf-c")]);

        const summary = await pushRoundtableRows("EVT", [table()], defaultSeats());

        expect(summary.results[0].reason).toBe("attendee_cancelled");
        expect(createAppointment).not.toHaveBeenCalled();
    });

    test("refuses a table whose host isn't linked in Cvent", async () => {
        loadAttendees.mockResolvedValue([delegate("sf-a", { cventContactId: "" }), delegate("sf-b"), delegate("sf-c")]);

        const summary = await pushRoundtableRows("EVT", [table()], defaultSeats());

        expect(summary.results[0].reason).toBe("host_not_in_cvent");
        expect(createAppointment).not.toHaveBeenCalled();
    });

    test("leaves an unlinked attendee off with a warning", async () => {
        loadAttendees.mockResolvedValue([delegate("sf-a"), delegate("sf-b", { cventContactId: "" }), delegate("sf-c")]);

        const summary = await pushRoundtableRows("EVT", [table()], defaultSeats());

        expect(created().attendeeContactIds).toEqual(["c-sf-c"]);
        expect(summary.results[0].warning).toContain("Name sf-b isn't linked in Cvent");
    });

    test("warns when the table sits in a slot that isn't delegate_group", async () => {
        loadEventScheduleData.mockResolvedValue({
            timeslotById: new Map([[SLOT.id, { ...SLOT, kind: "delegate_delegate", appointmentTypeName: "Delegate to Delegate Meetings" }]]),
            locationById: new Map(),
        });

        const summary = await pushRoundtableRows("EVT", [table()], defaultSeats());

        expect(summary.results[0].warning).toBe("Pushed as Delegate to Delegate Meetings.");
    });

    test("gives a table pushed before, then unpushed, a new appointment code", async () => {
        const lastPushedAt = new Date("2027-01-01T00:00:00Z");

        await pushRoundtableRows("EVT", [table({ lastPushedAt })], defaultSeats());

        expect(created().code).toBe(`rt-001-1-${lastPushedAt.getTime()}`);
    });

    test("reports a Cvent failure on the table without saving", async () => {
        createAppointment.mockRejectedValue(Object.assign(new Error("Conflict"), { statusCode: 409, body: "{}" }));

        const summary = await pushRoundtableRows("EVT", [table()], defaultSeats());

        expect(summary.results[0]).toMatchObject({ ok: false, reason: "cvent_conflict" });
        expect(saved).toHaveLength(0);
    });
});

describe("unpushRoundtableRows", () => {
    test("cancels through the shared cancel step and unlinks the table, keeping lastPushedAt", async () => {
        const pushed = table({ cventAppointmentId: "appt-1", lastPushedAt: new Date("2027-01-01T00:00:00Z") });

        const outcome = await unpushRoundtableRows("EVT", [pushed], (r) => r.id);

        expect(outcome).toMatchObject({ unpushed: 1, alreadyGone: 0, failures: [] });
        expect(cancelAppointment).toHaveBeenCalledWith("EVT", "appt-1");
        expect(saved).toEqual([{ cventAppointmentId: null }]);
    });

    test("keeps the table linked when Cvent's cancel fails", async () => {
        cancelAppointment.mockRejectedValue(Object.assign(new Error("Server error"), { statusCode: 500, body: "{}" }));

        const outcome = await unpushRoundtableRows("EVT", [table({ cventAppointmentId: "appt-1" })], (r) => r.id);

        expect(outcome.failures).toHaveLength(1);
        expect(saved).toHaveLength(0);
    });
});
