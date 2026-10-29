import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Attendee } from "@/types";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import type { ScheduledMeetingRow } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Multi-host push: pushMeetingRows expands a company (attendeeA = account id)
// to all its reps' Cvent contacts as hosts, with the delegate as the attendee.
// External deps (DB, Cvent client, loaders) are mocked so we assert the shape
// of the CventAppointmentInput handed to createAppointment.
// ---------------------------------------------------------------------------

const createAppointment = vi.fn();
const updateAppointment = vi.fn();
const cancelAppointment = vi.fn();
const loadAttendees = vi.fn();
const loadEventScheduleData = vi.fn();

const getAppointmentsByEvent = vi.fn();
const dbUpdate = vi.fn();

vi.mock("@/lib/cvent/client", () => ({
    createAppointment: (...a: unknown[]) => createAppointment(...a),
    updateAppointment: (...a: unknown[]) => updateAppointment(...a),
    cancelAppointment: (...a: unknown[]) => cancelAppointment(...a),
    getAppointmentsByEvent: (...a: unknown[]) => getAppointmentsByEvent(...a),
}));

/**
 * Builds the event's Cvent appointment list with one appointment, as getAppointmentsByEvent returns it.
 *
 * @param {string} id - The appointment id.
 * @param {string | null} typeName - The type name Cvent lists for it.
 * @param {string} [start] - Its start time. Defaults to the ts-1 slot's start, so it reads as a same-time move.
 * @returns The appointment summaries.
 */
function listed(id: string, typeName: string | null, start = "2025-01-15T09:00:00Z") {
    return [
        {
            id,
            startTime: new Date(start),
            endTime: new Date("2025-01-15T09:30:00Z"),
            locationName: "Booth 1",
            typeName,
        },
    ];
}
vi.mock("@/lib/attendees/loader", () => ({
    loadAttendees: (...a: unknown[]) => loadAttendees(...a),
}));
vi.mock("@/lib/cvent/mapper", () => ({
    loadEventScheduleData: (...a: unknown[]) => loadEventScheduleData(...a),
}));
vi.mock("@/lib/db/client", () => ({
    db: {
        update: (...a: unknown[]) => {
            dbUpdate(...a);
            return { set: () => ({ where: async () => undefined }) };
        },
    },
}));

import {
    appointmentCode,
    appointmentTypeWarning,
    pushMeetingRows,
    sameAppointmentType,
    sameStartTime,
} from "./push";

/** Minimal attendee builder. */
function att(
    partial: Pick<Attendee, "id" | "role"> & Partial<Attendee>,
): Attendee {
    return {
        id: partial.id,
        cventContactId: partial.cventContactId ?? "",
        cventCancelled: partial.cventCancelled,
        salesforceId: partial.salesforceId ?? partial.id,
        accountId: partial.accountId ?? "",
        name: partial.name ?? partial.id,
        email: "",
        phone: "",
        role: partial.role,
        company: partial.company ?? "",
        title: "",
        sponsorTier: partial.role === "sponsor" ? "standard" : null,
        profile: emptyProfile(),
        scheduling: {
            maxSameCompanyMeetings: partial.role === "sponsor" ? null : 2,
            requestedSponsorAccountIds: [],
        },
    };
}

/** Minimal scheduled_meetings row; attendeeA is a company account id. */
function row(overrides: Partial<ScheduledMeetingRow> = {}): ScheduledMeetingRow {
    return {
        id: "mtg-1",
        eventCode: "EVT",
        attendeeA: "acct-acme",
        attendeeB: "d1-sf",
        day: 1,
        timeslotId: "ts-1",
        passNumber: 1,
        mutual: false,
        matchKind: "sponsor_choice",
        rank: 5,
        source: "portal",
        locationId: "loc-1",
        cventAppointmentId: null,
        lastModifiedAt: null,
        lastPushedAt: null,
        createdAt: new Date("2025-01-01T00:00:00Z"),
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    createAppointment.mockResolvedValue("appt-123");
    // By default the old appointment already has the ts-1 slot's type, as Cvent names it.
    getAppointmentsByEvent.mockResolvedValue(listed("appt-old", "Sponsor to Delegate Meetings"));
    loadEventScheduleData.mockResolvedValue({
        timeslotById: new Map([
            [
                "ts-1",
                {
                    startTime: "2025-01-15T09:00:00Z",
                    endTime: "2025-01-15T09:30:00Z",
                    appointmentTypeId: "type-1",
                    appointmentTypeName: "Sponsor to Delegate Meetings",
                    kind: "sponsor_delegate",
                },
            ],
            [
                "ts-group",
                {
                    startTime: "2025-01-15T10:00:00Z",
                    endTime: "2025-01-15T10:30:00Z",
                    appointmentTypeId: "type-group",
                    appointmentTypeName: "Delegate Group Meetings",
                    kind: "ignore",
                },
            ],
        ]),
    });
});

/** Reads the CventAppointmentInput passed to createAppointment. */
function lastInput() {
    return createAppointment.mock.calls[0][1];
}

describe("pushMeetingRows — multi-host", () => {
    test("hosts all of a company's reps and sets the delegate as the attendee", async () => {
        loadAttendees.mockResolvedValue([
            att({ id: "s1", role: "sponsor", company: "Acme", accountId: "acct-acme", cventContactId: "h1" }),
            att({ id: "s2", role: "sponsor", company: "Acme", accountId: "acct-acme", cventContactId: "h2" }),
            att({ id: "d1", role: "delegate", salesforceId: "d1-sf", name: "Dee", cventContactId: "cd1" }),
        ]);

        const summary = await pushMeetingRows("EVT", [row()]);

        expect(summary.pushed).toBe(1);
        expect([...lastInput().hostContactIds].sort()).toEqual(["h1", "h2"]);
        expect(lastInput().attendeeContactIds).toEqual(["cd1"]);
        // Company-name based label.
        expect(lastInput().subject).toBe("Acme & Dee");
    });

    test("pushes with the linked reps only and warns when one rep lacks a Cvent id", async () => {
        loadAttendees.mockResolvedValue([
            att({ id: "s1", role: "sponsor", company: "Acme", accountId: "acct-acme", cventContactId: "h1" }),
            att({ id: "s2", role: "sponsor", company: "Acme", accountId: "acct-acme", cventContactId: "" }),
            att({ id: "d1", role: "delegate", salesforceId: "d1-sf", cventContactId: "cd1" }),
        ]);

        const summary = await pushMeetingRows("EVT", [row()]);

        expect(summary.pushed).toBe(1);
        expect(lastInput().hostContactIds).toEqual(["h1"]);
        expect(summary.results[0].warning).toBeTruthy();
    });

    test("does not push when no rep of the company has a Cvent id", async () => {
        loadAttendees.mockResolvedValue([
            att({ id: "s1", role: "sponsor", company: "Acme", accountId: "acct-acme", cventContactId: "" }),
            att({ id: "s2", role: "sponsor", company: "Acme", accountId: "acct-acme", cventContactId: "" }),
            att({ id: "d1", role: "delegate", salesforceId: "d1-sf", cventContactId: "cd1" }),
        ]);

        const summary = await pushMeetingRows("EVT", [row()]);

        expect(summary.pushed).toBe(0);
        expect(summary.results[0].reason).toBe("host_not_in_cvent");
        expect(createAppointment).not.toHaveBeenCalled();
    });

    test("creates a host-only appointment (with a warning) when the delegate is unlinked", async () => {
        loadAttendees.mockResolvedValue([
            att({ id: "s1", role: "sponsor", company: "Acme", accountId: "acct-acme", cventContactId: "h1" }),
            att({ id: "d1", role: "delegate", salesforceId: "d1-sf", cventContactId: "" }),
        ]);

        const summary = await pushMeetingRows("EVT", [row()]);

        expect(summary.pushed).toBe(1);
        expect(lastInput().hostContactIds).toEqual(["h1"]);
        expect(lastInput().attendeeContactIds).toEqual([]);
        expect(summary.results[0].warning).toBeTruthy();
    });
});

/**
 * Builds an error shaped like the Cvent SDK's API error, with an HTTP status
 * and a JSON body carrying Cvent's error code.
 *
 * @param {number} statusCode - The HTTP status Cvent returned.
 * @param {string} code - Cvent's error code from the response body.
 * @returns {Error} The SDK-shaped error.
 */
function cventError(statusCode: number, code: string): Error {
    return Object.assign(new Error(`API error occurred: Status ${statusCode}`), {
        statusCode,
        body: JSON.stringify({ message: `Cvent says ${code}`, code }),
    });
}

describe("pushMeetingRows — re-push at the same time", () => {
    beforeEach(() => {
        loadAttendees.mockResolvedValue([
            att({ id: "s1", role: "sponsor", company: "Acme", accountId: "acct-acme", cventContactId: "h1" }),
            att({ id: "d1", role: "delegate", salesforceId: "d1-sf", cventContactId: "cd1" }),
        ]);
    });

    test("updates the old appointment in place when the replacement collides with it", async () => {
        createAppointment.mockRejectedValue(
            cventError(409, "NO_MORE_APPT_AT_THIS_TIME_FOR_HOST"),
        );
        updateAppointment.mockResolvedValue("appt-old");

        const summary = await pushMeetingRows("EVT", [
            row({ cventAppointmentId: "appt-old", locationId: "loc-2" }),
        ]);

        expect(summary.pushed).toBe(1);
        expect(summary.results[0].cventAppointmentId).toBe("appt-old");
        expect(updateAppointment).toHaveBeenCalledWith(
            "EVT",
            "appt-old",
            expect.objectContaining({ locationId: "loc-2" }),
        );
        // The appointment was edited, not replaced, so nothing is cancelled.
        expect(cancelAppointment).not.toHaveBeenCalled();
    });

    test("reports the update's error when the in-place update also fails", async () => {
        createAppointment.mockRejectedValue(
            cventError(409, "NO_MORE_APPT_AT_THIS_TIME_FOR_HOST"),
        );
        updateAppointment.mockRejectedValue(
            cventError(409, "NO_MORE_APPT_AT_THIS_TIME_FOR_HOST"),
        );

        const summary = await pushMeetingRows("EVT", [
            row({ cventAppointmentId: "appt-old" }),
        ]);

        expect(summary.pushed).toBe(0);
        expect(summary.results[0].reason).toBe("cvent_no_availability");
        expect(cancelAppointment).not.toHaveBeenCalled();
    });

    test("does not try an update for a meeting that was never pushed", async () => {
        createAppointment.mockRejectedValue(
            cventError(409, "NO_MORE_APPT_AT_THIS_TIME_FOR_HOST"),
        );

        const summary = await pushMeetingRows("EVT", [row()]);

        expect(summary.pushed).toBe(0);
        expect(updateAppointment).not.toHaveBeenCalled();
    });

    test("does not try an update for errors other than availability", async () => {
        createAppointment.mockRejectedValue(
            cventError(422, "ATTENDEE_NOT_FOUND"),
        );

        const summary = await pushMeetingRows("EVT", [
            row({ cventAppointmentId: "appt-old" }),
        ]);

        expect(summary.pushed).toBe(0);
        expect(updateAppointment).not.toHaveBeenCalled();
        expect(cancelAppointment).not.toHaveBeenCalled();
    });

    test("still creates then cancels when the replacement succeeds", async () => {
        createAppointment.mockResolvedValue("appt-new");

        const summary = await pushMeetingRows("EVT", [
            row({ cventAppointmentId: "appt-old" }),
        ]);

        expect(summary.results[0].cventAppointmentId).toBe("appt-new");
        expect(updateAppointment).not.toHaveBeenCalled();
        expect(cancelAppointment).toHaveBeenCalledWith("EVT", "appt-old");
    });

    test("updates a same-type, same-time booth change in place, reading the type from the event's appointment list", async () => {
        createAppointment.mockRejectedValue(
            cventError(409, "NO_MORE_APPT_AT_THIS_TIME_FOR_HOST"),
        );
        updateAppointment.mockResolvedValue("appt-old");

        const summary = await pushMeetingRows("EVT", [
            row({ cventAppointmentId: "appt-old", locationId: "booth-2" }),
        ]);

        expect(getAppointmentsByEvent).toHaveBeenCalledWith("EVT");
        expect(summary.pushed).toBe(1);
        expect(updateAppointment).toHaveBeenCalledWith(
            "EVT",
            "appt-old",
            expect.objectContaining({ locationId: "booth-2" }),
        );
        expect(dbUpdate).toHaveBeenCalled();
    });

    test("lists the event's appointments once for a whole batch", async () => {
        createAppointment.mockRejectedValue(
            cventError(409, "NO_MORE_APPT_AT_THIS_TIME_FOR_HOST"),
        );
        updateAppointment.mockImplementation(async (_e: string, id: string) => id);
        getAppointmentsByEvent.mockResolvedValue([
            ...listed("appt-a", "Sponsor to Delegate Meetings"),
            ...listed("appt-b", "Sponsor to Delegate Meetings"),
        ]);

        const summary = await pushMeetingRows("EVT", [
            row({ id: "m-a", cventAppointmentId: "appt-a" }),
            row({ id: "m-b", cventAppointmentId: "appt-b" }),
        ]);

        expect(summary.pushed).toBe(2);
        expect(getAppointmentsByEvent).toHaveBeenCalledTimes(1);
    });

    test("does not update, cancel or save when the new slot has another type", async () => {
        // The meeting was pushed as Delegate Group and now moves to the same-time sponsor slot.
        createAppointment.mockRejectedValue(
            cventError(409, "NO_MORE_APPT_AT_THIS_TIME_FOR_HOST"),
        );
        getAppointmentsByEvent.mockResolvedValue(listed("appt-old", "Delegate Group Meetings"));

        const summary = await pushMeetingRows("EVT", [
            row({ cventAppointmentId: "appt-old" }),
        ]);

        expect(summary.pushed).toBe(0);
        expect(summary.results[0].reason).toBe("cvent_type_change");
        expect(summary.results[0].error).toContain('still in Cvent as "Delegate Group Meetings"');
        expect(summary.results[0].error).toContain("Unpush All Synced");
        expect(updateAppointment).not.toHaveBeenCalled();
        expect(cancelAppointment).not.toHaveBeenCalled();
        expect(dbUpdate).not.toHaveBeenCalled();
    });

    test("reports a busy host for a move to another time, with no update, cancel or save", async () => {
        // The old appointment is at 08:00, and the meeting moved to the 09:00 ts-1 slot.
        createAppointment.mockRejectedValue(
            cventError(409, "NO_MORE_APPT_AT_THIS_TIME_FOR_HOST"),
        );
        getAppointmentsByEvent.mockResolvedValue(
            listed("appt-old", "Sponsor to Delegate Meetings", "2025-01-15T08:00:00Z"),
        );

        const summary = await pushMeetingRows("EVT", [
            row({ cventAppointmentId: "appt-old" }),
        ]);

        expect(summary.pushed).toBe(0);
        expect(summary.results[0].reason).toBe("cvent_no_availability");
        expect(updateAppointment).not.toHaveBeenCalled();
        expect(cancelAppointment).not.toHaveBeenCalled();
        expect(dbUpdate).not.toHaveBeenCalled();
    });

    test("reports a busy host when the old appointment is missing from the event's appointment list", async () => {
        createAppointment.mockRejectedValue(
            cventError(409, "NO_MORE_APPT_AT_THIS_TIME_FOR_HOST"),
        );
        getAppointmentsByEvent.mockResolvedValue(listed("some-other-appt", "Sponsor to Delegate Meetings"));

        const summary = await pushMeetingRows("EVT", [
            row({ cventAppointmentId: "appt-old" }),
        ]);

        expect(summary.results[0].reason).toBe("cvent_no_availability");
        expect(updateAppointment).not.toHaveBeenCalled();
        expect(cancelAppointment).not.toHaveBeenCalled();
        expect(dbUpdate).not.toHaveBeenCalled();
    });

    test("reports a busy host when the appointment list can't be read", async () => {
        createAppointment.mockRejectedValue(
            cventError(409, "NO_MORE_APPT_AT_THIS_TIME_FOR_HOST"),
        );
        getAppointmentsByEvent.mockRejectedValue(new Error("fetch failed"));

        const summary = await pushMeetingRows("EVT", [
            row({ cventAppointmentId: "appt-old" }),
        ]);

        expect(summary.results[0].reason).toBe("cvent_no_availability");
        expect(updateAppointment).not.toHaveBeenCalled();
        expect(cancelAppointment).not.toHaveBeenCalled();
        expect(dbUpdate).not.toHaveBeenCalled();
    });

    test("fails safe at the same time when Cvent lists the old appointment with no type name", async () => {
        createAppointment.mockRejectedValue(
            cventError(409, "NO_MORE_APPT_AT_THIS_TIME_FOR_HOST"),
        );
        getAppointmentsByEvent.mockResolvedValue(listed("appt-old", null));

        const summary = await pushMeetingRows("EVT", [
            row({ cventAppointmentId: "appt-old" }),
        ]);

        expect(summary.results[0].reason).toBe("cvent_type_change");
        expect(summary.results[0].error).toContain("couldn't check");
        expect(updateAppointment).not.toHaveBeenCalled();
        expect(cancelAppointment).not.toHaveBeenCalled();
        expect(dbUpdate).not.toHaveBeenCalled();
    });

    test("treats differently formatted ISO strings for the same moment as the same time", async () => {
        createAppointment.mockRejectedValue(
            cventError(409, "NO_MORE_APPT_AT_THIS_TIME_FOR_HOST"),
        );
        updateAppointment.mockResolvedValue("appt-old");
        // ts-1 starts at "2025-01-15T09:00:00Z". This is the same moment, written with an offset.
        getAppointmentsByEvent.mockResolvedValue(
            listed("appt-old", "Sponsor to Delegate Meetings", "2025-01-15T04:00:00.000-05:00"),
        );

        const summary = await pushMeetingRows("EVT", [
            row({ cventAppointmentId: "appt-old" }),
        ]);

        expect(summary.pushed).toBe(1);
        expect(updateAppointment).toHaveBeenCalled();
    });
});

describe("sameStartTime", () => {
    test("compares moments, not strings", () => {
        expect(sameStartTime(new Date("2025-01-15T09:00:00Z"), "2025-01-15T09:00:00.000Z")).toBe(true);
        expect(sameStartTime("2025-01-15T04:00:00-05:00", "2025-01-15T09:00:00Z")).toBe(true);
        expect(sameStartTime(new Date("2025-01-15T08:00:00Z"), "2025-01-15T09:00:00Z")).toBe(false);
    });

    test("never matches an unknown or unparseable time", () => {
        expect(sameStartTime(null, "2025-01-15T09:00:00Z")).toBe(false);
        expect(sameStartTime(new Date("nonsense"), "2025-01-15T09:00:00Z")).toBe(false);
        expect(sameStartTime(new Date("2025-01-15T09:00:00Z"), "")).toBe(false);
    });
});

describe("sameAppointmentType", () => {
    const slot = { appointmentTypeName: "Sponsor to Delegate Meetings" };

    test("matches by name, ignoring surrounding spaces", () => {
        expect(sameAppointmentType("Sponsor to Delegate Meetings", slot)).toBe(true);
        expect(sameAppointmentType(" Sponsor to Delegate Meetings ", slot)).toBe(true);
        expect(sameAppointmentType("Delegate Group Meetings", slot)).toBe(false);
    });

    test("never matches an unknown type", () => {
        expect(sameAppointmentType(null, slot)).toBe(false);
        expect(
            sameAppointmentType("Sponsor to Delegate Meetings", { appointmentTypeName: null }),
        ).toBe(false);
    });
});

describe("pushMeetingRows — cancelled Cvent registrations", () => {
    test("skips the meeting when the delegate cancelled in Cvent", async () => {
        loadAttendees.mockResolvedValue([
            att({ id: "s1", role: "sponsor", company: "Acme", accountId: "acct-acme", cventContactId: "h1" }),
            att({ id: "d1", role: "delegate", salesforceId: "d1-sf", name: "Dee", cventContactId: "cd1", cventCancelled: true }),
        ]);

        const summary = await pushMeetingRows("EVT", [row()]);

        expect(summary.pushed).toBe(0);
        expect(summary.results[0].reason).toBe("attendee_cancelled");
        expect(summary.results[0].error).toContain("Dee");
        expect(createAppointment).not.toHaveBeenCalled();
    });

    test("leaves a cancelled rep off as a host and warns, but still pushes", async () => {
        loadAttendees.mockResolvedValue([
            att({ id: "s1", role: "sponsor", company: "Acme", accountId: "acct-acme", cventContactId: "h1" }),
            att({ id: "s2", role: "sponsor", company: "Acme", accountId: "acct-acme", name: "Sam", cventContactId: "h2", cventCancelled: true }),
            att({ id: "d1", role: "delegate", salesforceId: "d1-sf", cventContactId: "cd1" }),
        ]);

        const summary = await pushMeetingRows("EVT", [row()]);

        expect(summary.pushed).toBe(1);
        expect(lastInput().hostContactIds).toEqual(["h1"]);
        expect(summary.results[0].warning).toBe(
            "Sam cancelled in Cvent, so that rep was not added as a host.",
        );
    });

    test("skips the meeting when every rep of the company cancelled", async () => {
        loadAttendees.mockResolvedValue([
            att({ id: "s1", role: "sponsor", company: "Acme", accountId: "acct-acme", cventContactId: "h1", cventCancelled: true }),
            att({ id: "d1", role: "delegate", salesforceId: "d1-sf", cventContactId: "cd1" }),
        ]);

        const summary = await pushMeetingRows("EVT", [row()]);

        expect(summary.pushed).toBe(0);
        expect(summary.results[0].reason).toBe("attendee_cancelled");
        expect(createAppointment).not.toHaveBeenCalled();
    });
});

describe("pushMeetingRows — appointment type", () => {
    beforeEach(() => {
        loadAttendees.mockResolvedValue([
            att({ id: "s1", role: "sponsor", company: "Acme", accountId: "acct-acme", cventContactId: "h1" }),
            att({ id: "d1", role: "delegate", salesforceId: "d1-sf", cventContactId: "cd1" }),
        ]);
    });

    test("pushes a meeting on a non-sponsor slot with that slot's type, and warns naming the type", async () => {
        const summary = await pushMeetingRows("EVT", [row({ timeslotId: "ts-group" })]);

        expect(summary.pushed).toBe(1);
        expect(lastInput().appointmentTypeId).toBe("type-group");
        expect(summary.results[0].warning).toBe("Pushed as Delegate Group Meetings.");
    });

    test("gives a meeting on a sponsor_delegate slot no type warning", async () => {
        const summary = await pushMeetingRows("EVT", [row()]);

        expect(summary.pushed).toBe(1);
        expect(lastInput().appointmentTypeId).toBe("type-1");
        expect(summary.results[0].warning).toBeUndefined();
    });
});

describe("appointmentTypeWarning", () => {
    test("falls back to the type id when Cvent didn't name the type", () => {
        expect(
            appointmentTypeWarning({
                kind: "delegate_delegate",
                appointmentTypeId: "type-d2d",
                appointmentTypeName: null,
            }),
        ).toBe("Pushed as type-d2d.");
    });
});

describe("appointmentCode", () => {
    test("uses the plain meeting id for a meeting never pushed", () => {
        expect(appointmentCode(row({ lastPushedAt: null }))).toBe("mtg-1");
    });

    test("adds the last push time for a meeting pushed before", () => {
        const lastPushedAt = new Date("2025-01-15T09:00:00Z");
        expect(appointmentCode(row({ lastPushedAt }))).toBe(
            `mtg-1-${lastPushedAt.getTime()}`,
        );
    });

    test("gives an unpushed meeting a new code, since unpush keeps lastPushedAt", () => {
        const lastPushedAt = new Date("2025-01-15T09:00:00Z");
        const unpushed = row({ cventAppointmentId: null, lastPushedAt });
        expect(appointmentCode(unpushed)).not.toBe("mtg-1");
    });

    test("repeats the same code on a retry, so Cvent can reject a duplicate", () => {
        const pushed = row({ lastPushedAt: new Date("2025-01-15T09:00:00Z") });
        expect(appointmentCode(pushed)).toBe(appointmentCode(pushed));
    });

    test("is sent as the appointment code on push", async () => {
        loadAttendees.mockResolvedValue([
            att({ id: "s1", role: "sponsor", company: "Acme", accountId: "acct-acme", cventContactId: "h1" }),
            att({ id: "d1", role: "delegate", salesforceId: "d1-sf", cventContactId: "cd1" }),
        ]);
        const lastPushedAt = new Date("2025-01-15T09:00:00Z");

        await pushMeetingRows("EVT", [row({ lastPushedAt })]);

        expect(lastInput().code).toBe(`mtg-1-${lastPushedAt.getTime()}`);
    });
});
