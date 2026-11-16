import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Attendee, Timeslot } from "@/types";
import type { ScheduledMeetingRow } from "@/lib/db/schema";
import type { MatchingContext } from "@/lib/matching/data";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { DEFAULT_MATCHING_SETTINGS } from "@/lib/matching/settings";

// ---------------------------------------------------------------------------
// Moving and removing one D2D meeting. The matching data, the DB and Cvent are mocked.
// ---------------------------------------------------------------------------

const loadMatchingContext = vi.fn();
const cancelAppointment = vi.fn();
const dbUpdate = vi.fn();
const dbDelete = vi.fn();
let SELECTED: ScheduledMeetingRow[] = [];

vi.mock("@/lib/matching/data", () => ({
    loadMatchingContext: (...a: unknown[]) => loadMatchingContext(...a),
}));
vi.mock("@/lib/cvent/client", () => ({
    cancelAppointment: (...a: unknown[]) => cancelAppointment(...a),
}));
vi.mock("@/lib/cvent/push", () => ({ needsSync: vi.fn(), pushDelegateMeetingRows: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
    db: {
        select: () => ({ from: () => ({ where: () => ({ limit: async () => SELECTED }) }) }),
        update: (...a: unknown[]) => {
            dbUpdate(...a);
            return { set: () => ({ where: async () => undefined }) };
        },
        delete: (...a: unknown[]) => {
            dbDelete(...a);
            return { where: async () => undefined };
        },
    },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getDelegateMeetingDetail, moveD2DMeeting, removeD2DMeeting } from "./actions";

/**
 * Builds a delegate with a completed Networking Profile.
 *
 * @param {string} id - The Salesforce id, also used for the Cvent contact id.
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
        company: id,
        title: "",
        sponsorTier: null,
        networkingProfileComplete: true,
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: 2, requestedSponsorAccountIds: [] },
    };
}

/**
 * Builds a Day 1 slot lasting 20 minutes.
 *
 * @param {string} id - The timeslot id.
 * @param {string} hhmm - The start time.
 * @param {Timeslot["kind"]} [kind] - The slot's meeting kind. Defaults to delegate_delegate.
 * @returns {Timeslot} The slot.
 */
function slot(id: string, hhmm: string, kind: Timeslot["kind"] = "delegate_delegate"): Timeslot {
    const start = new Date(`2027-01-20T${hhmm}:00.000Z`);
    return {
        id,
        day: 1,
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 20 * 60000).toISOString(),
        capacity: 5,
        locationId: `loc-${id}`,
        appointmentTypeId: kind,
        appointmentTypeName: kind,
        kind,
    };
}

/**
 * Builds a scheduled_meetings row.
 *
 * @param {Partial<ScheduledMeetingRow>} partial - The fields to set.
 * @returns {ScheduledMeetingRow} The row.
 */
function row(partial: Partial<ScheduledMeetingRow>): ScheduledMeetingRow {
    return {
        id: "m1",
        eventCode: "EVT",
        kind: "delegate_delegate",
        attendeeA: "d1",
        attendeeB: "d2",
        day: 1,
        timeslotId: "t1",
        passNumber: 6,
        mutual: false,
        matchKind: "profile_match",
        rank: null,
        source: "portal",
        locationId: "loc-t1",
        cventAppointmentId: null,
        lastModifiedAt: null,
        lastPushedAt: null,
        createdAt: new Date(0),
        ...partial,
    };
}

const SLOTS = [slot("t1", "09:00"), slot("t2", "10:00"), slot("t3", "11:00"), slot("s2d", "12:00", "sponsor_delegate")];

/**
 * Builds the matching data, with d1 and d2 meeting at t1.
 *
 * @param {ScheduledMeetingRow[]} extraRows - Other meetings.
 * @param {{ roundtableId: string; delegateId: string; timeslotId: string }[]} [seats] - Roundtable seats.
 * @returns {MatchingContext} The data.
 */
function context(
    extraRows: ScheduledMeetingRow[],
    seats: { roundtableId: string; delegateId: string; timeslotId: string }[] = [],
): MatchingContext {
    return {
        attendees: ["d1", "d2", "d3"].map(delegate),
        scheduleData: {
            timeslots: SLOTS,
            locations: [],
            timeslotById: new Map(SLOTS.map((t) => [t.id, t])),
            locationById: new Map(),
            timezone: "UTC",
            appointmentTypes: [],
            appointmentTypeKinds: null,
        },
        settings: DEFAULT_MATCHING_SETTINGS,
        rows: [row({}), ...extraRows],
        roundtableRows: seats.map((s) => ({
            id: s.roundtableId,
            eventCode: "EVT",
            timeslotId: s.timeslotId,
            locationId: null,
            themeTitle: null,
            description: null,
            cventAppointmentId: null,
            lastModifiedAt: null,
            lastPushedAt: null,
            createdAt: new Date(0),
        })),
        seatRows: seats.map((s, i) => ({
            id: i + 1,
            eventCode: "EVT",
            roundtableId: s.roundtableId,
            delegateId: s.delegateId,
            role: "seated" as const,
            position: 1,
            reason: null,
            score: null,
            createdAt: new Date(0),
        })),
        appointments: [],
        cventOnly: [],
        counts: new Map(),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    SELECTED = [];
});

describe("moveD2DMeeting", () => {
    test("refuses a slot that isn't a Delegate to Delegate slot", async () => {
        loadMatchingContext.mockResolvedValue(context([]));

        const result = await moveD2DMeeting({ id: "m1", eventCode: "EVT", timeslotId: "s2d" });

        expect(result).toEqual({ ok: false, error: "Error: D2D meetings can only use Delegate to Delegate slots" });
        expect(dbUpdate).not.toHaveBeenCalled();
    });

    test("refuses a slot where one of the delegates already has a meeting", async () => {
        loadMatchingContext.mockResolvedValue(
            context([row({ id: "s2d-1", kind: "sponsor_delegate", attendeeA: "acct-x", attendeeB: "d2", timeslotId: "t2" })]),
        );

        const result = await moveD2DMeeting({ id: "m1", eventCode: "EVT", timeslotId: "t2" });

        expect(result).toEqual({ ok: false, error: "Error: d2 already has a meeting at that time" });
        expect(dbUpdate).not.toHaveBeenCalled();
    });

    test("refuses a slot at the time of a delegate's roundtable seat", async () => {
        loadMatchingContext.mockResolvedValue(context([], [{ roundtableId: "rt", delegateId: "d1", timeslotId: "t3" }]));

        const result = await moveD2DMeeting({ id: "m1", eventCode: "EVT", timeslotId: "t3" });

        expect(result).toEqual({ ok: false, error: "Error: d1 already has a meeting at that time" });
        expect(dbUpdate).not.toHaveBeenCalled();
    });

    test("moves the meeting to a free D2D slot", async () => {
        loadMatchingContext.mockResolvedValue(context([]));

        const result = await moveD2DMeeting({ id: "m1", eventCode: "EVT", timeslotId: "t2" });

        expect(result).toEqual({ ok: true });
        expect(dbUpdate).toHaveBeenCalledTimes(1);
    });
});

describe("removeD2DMeeting", () => {
    test("cancels a pushed meeting in Cvent before deleting it", async () => {
        SELECTED = [row({ cventAppointmentId: "appt-1" })];

        const result = await removeD2DMeeting({ id: "m1" });

        expect(result).toEqual({ ok: true });
        expect(cancelAppointment).toHaveBeenCalledWith("EVT", "appt-1");
        expect(cancelAppointment.mock.invocationCallOrder[0]).toBeLessThan(dbDelete.mock.invocationCallOrder[0]);
    });

    test("keeps the meeting and says why when the Cvent cancel fails", async () => {
        SELECTED = [row({ cventAppointmentId: "appt-1" })];
        cancelAppointment.mockRejectedValue(new Error("Cvent is down"));

        const result = await removeD2DMeeting({ id: "m1" });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("the meeting was kept");
        expect(dbDelete).not.toHaveBeenCalled();
    });

    test("still removes a meeting whose appointment is already gone in Cvent", async () => {
        SELECTED = [row({ cventAppointmentId: "appt-1" })];
        cancelAppointment.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 404 }));

        expect(await removeD2DMeeting({ id: "m1" })).toEqual({ ok: true });
        expect(dbDelete).toHaveBeenCalledTimes(1);
    });

    test("deletes an unpushed meeting without calling Cvent", async () => {
        SELECTED = [row({})];

        expect(await removeD2DMeeting({ id: "m1" })).toEqual({ ok: true });
        expect(cancelAppointment).not.toHaveBeenCalled();
        expect(dbDelete).toHaveBeenCalledTimes(1);
    });
});

describe("getDelegateMeetingDetail: roundtable seats", () => {
    test("shows the seated_at_roundtable reason for a delegate seated at a roundtable", async () => {
        loadMatchingContext.mockResolvedValue(context([], [{ roundtableId: "rt", delegateId: "d3", timeslotId: "t3" }]));

        const seated = await getDelegateMeetingDetail({ delegateId: "d3", eventCode: "EVT" });
        const free = await getDelegateMeetingDetail({ delegateId: "d1", eventCode: "EVT" });

        expect(seated?.delegate.exclusion).toBe("seated_at_roundtable");
        expect(free?.delegate.exclusion).toBeNull();
    });
});
