import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Attendee, Timeslot } from "@/types";
import type { AppointmentTypeKinds } from "@/lib/events/meetingKinds";
import { emptyProfile } from "@/lib/attendees/formatProfile";

// ---------------------------------------------------------------------------
// runSchedulerForEvent and the appointment-type mapping.
// The DB, attendee loader, Cvent client and schedule loader are all mocked.
// The tests check whether the run touches the scheduled_meetings table.
// ---------------------------------------------------------------------------

const loadAttendees = vi.fn();
const loadEventScheduleData = vi.fn();
const dbDelete = vi.fn();
const dbInsert = vi.fn();
const insertValues = vi.fn<(rows: unknown) => Promise<void>>(async () => undefined);

vi.mock("@/lib/db/client", () => ({
    db: {
        select: () => ({
            from: (table: unknown) => ({
                where: async () => (table === meetingRequestsTable() ? REQUESTS : []),
            }),
        }),
        delete: (...a: unknown[]) => dbDelete(...a),
        insert: (...a: unknown[]) => dbInsert(...a),
    },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/attendees/loader", () => ({
    loadAttendees: (...a: unknown[]) => loadAttendees(...a),
}));
vi.mock("@/lib/cvent/mapper", () => ({
    loadEventScheduleData: (...a: unknown[]) => loadEventScheduleData(...a),
}));
vi.mock("@/lib/cvent/client", () => ({
    getEventAppointments: async () => [],
    cancelAppointment: vi.fn(),
}));
vi.mock("@/lib/cvent/push", () => ({
    pushMeetingRows: vi.fn(),
    needsSync: vi.fn(),
}));

import { runSchedulerForEvent } from "./actions";
import { NO_ATTENDEES_MESSAGE } from "@/lib/scheduling/helpers";
import { meetingRequests } from "@/lib/db/schema";
import {
    NO_SPONSOR_MAPPING_MESSAGE,
    NO_SPONSOR_SLOTS_MESSAGE,
} from "@/lib/events/meetingKinds";

/**
 * Returns the meeting_requests table object, read lazily since vi.mock is hoisted above the imports.
 *
 * @returns {unknown} The drizzle table.
 */
function meetingRequestsTable(): unknown {
    return meetingRequests;
}

// One sponsor request from Acme to Dee.
const REQUESTS = [
    { id: 1, requesterId: "acct-acme", targetId: "d1", rank: 5, eventCode: "EVT" },
];

/**
 * Minimal attendee builder.
 *
 * @param {Pick<Attendee, "salesforceId" | "role"> & Partial<Attendee>} partial - Fields to set.
 * @returns {Attendee} The attendee.
 */
function att(
    partial: Pick<Attendee, "salesforceId" | "role"> & Partial<Attendee>,
): Attendee {
    return {
        id: partial.salesforceId,
        cventContactId: "",
        cventCancelled: partial.cventCancelled,
        salesforceId: partial.salesforceId,
        accountId: partial.accountId ?? "",
        name: partial.name ?? partial.salesforceId,
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

const TYPES = [
    { id: "t-s2d", name: "Sponsor to Delegate Meetings" },
    { id: "t-group", name: "Delegate Group Meetings" },
    { id: "t-lunch", name: "Themed Lunches (Round Tables)" },
];

/**
 * Builds a Day 1 timeslot with the kind the mapping gives its type.
 *
 * @param {string} id - The timeslot id.
 * @param {string} startTime - ISO start time.
 * @param {string} appointmentTypeId - The Cvent appointment-type id.
 * @param {AppointmentTypeKinds | null} kinds - The event's mapping.
 * @returns {Timeslot} The timeslot.
 */
function slot(
    id: string,
    startTime: string,
    appointmentTypeId: string,
    kinds: AppointmentTypeKinds | null,
): Timeslot {
    return {
        id,
        day: 1,
        startTime,
        endTime: startTime,
        capacity: 5,
        locationId: "loc-1",
        appointmentTypeId,
        appointmentTypeName: TYPES.find((t) => t.id === appointmentTypeId)?.name ?? null,
        kind: kinds?.[appointmentTypeId] ?? "ignore",
    };
}

/**
 * Sets up loadEventScheduleData for an event with the given mapping.
 * The Delegate Group slot comes first, so it would win if kinds were ignored.
 *
 * @param {AppointmentTypeKinds | null} kinds - The event's mapping.
 * @param {Timeslot[]} [slots] - Loaded timeslots to use instead, for example none when Cvent failed.
 */
function scheduleWith(kinds: AppointmentTypeKinds | null, slots?: Timeslot[]) {
    const timeslots = slots ?? [
        slot("ts-group", "2026-01-20T09:00:00Z", "t-group", kinds),
        slot("ts-s2d", "2026-01-20T10:00:00Z", "t-s2d", kinds),
    ];
    loadEventScheduleData.mockResolvedValue({
        timeslots,
        locations: [],
        timeslotById: new Map(timeslots.map((t) => [t.id, t])),
        locationById: new Map(),
        timezone: "UTC",
        appointmentTypes: TYPES,
        appointmentTypeKinds: kinds,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("USE_MOCK", "false");
    dbDelete.mockReturnValue({ where: async () => undefined });
    dbInsert.mockReturnValue({ values: insertValues });
    loadAttendees.mockResolvedValue([
        att({ salesforceId: "s1", role: "sponsor", accountId: "acct-acme", company: "Acme" }),
        att({ salesforceId: "d1", role: "delegate", name: "Dee", company: "Globex" }),
    ]);
});

describe("runSchedulerForEvent — appointment-type mapping", () => {
    test("stops with a clear message and leaves every meeting untouched when nothing is mapped", async () => {
        scheduleWith(null);

        const result = await runSchedulerForEvent("EVT");

        expect(result).toEqual({ ok: false, error: NO_SPONSOR_MAPPING_MESSAGE });
        expect(NO_SPONSOR_MAPPING_MESSAGE).toContain("Event settings");
        expect(dbDelete).not.toHaveBeenCalled();
        expect(dbInsert).not.toHaveBeenCalled();
    });

    test("stops when other types are mapped but none is sponsor_delegate", async () => {
        scheduleWith({ "t-group": "delegate_group" });

        const result = await runSchedulerForEvent("EVT");

        expect(result.ok).toBe(false);
        expect(dbDelete).not.toHaveBeenCalled();
        expect(dbInsert).not.toHaveBeenCalled();
    });

    test("stops and changes nothing when sponsor_delegate is mapped to an id no loaded slot has", async () => {
        // A stale mapping, for example kept from another Cvent appointment event.
        scheduleWith({ "t-old-event": "sponsor_delegate" });

        const result = await runSchedulerForEvent("EVT");

        expect(result).toEqual({ ok: false, error: NO_SPONSOR_SLOTS_MESSAGE });
        expect(dbDelete).not.toHaveBeenCalled();
        expect(dbInsert).not.toHaveBeenCalled();
    });

    test("stops and changes nothing when Cvent returned no timeslots", async () => {
        scheduleWith({ "t-s2d": "sponsor_delegate" }, []);

        const result = await runSchedulerForEvent("EVT");

        expect(result).toEqual({ ok: false, error: NO_SPONSOR_SLOTS_MESSAGE });
        expect(dbDelete).not.toHaveBeenCalled();
        expect(dbInsert).not.toHaveBeenCalled();
    });

    test("runs with only sponsor_delegate mapped and warns about each unmapped type by name", async () => {
        scheduleWith({ "t-s2d": "sponsor_delegate" });

        const result = await runSchedulerForEvent("EVT");

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.report.unmappedAppointmentTypes).toEqual([
            "Delegate Group Meetings",
            "Themed Lunches (Round Tables)",
        ]);
        expect(result.report.meetingsScheduled).toBe(1);
        expect(dbDelete).toHaveBeenCalledTimes(1);

        // The meeting went into the sponsor slot, not the earlier Delegate Group slot.
        const inserted = insertValues.mock.calls[0][0] as { timeslotId: string }[];
        expect(inserted.map((m) => m.timeslotId)).toEqual(["ts-s2d"]);
    });
});

describe("runSchedulerForEvent — attendees didn't load", () => {
    const SPONSOR = att({ salesforceId: "s1", role: "sponsor", accountId: "acct-acme", company: "Acme" });
    const DELEGATE = att({ salesforceId: "d1", role: "delegate", name: "Dee", company: "Globex" });

    /**
     * Runs the scheduler with a valid mapping and the given attendees, and checks it stopped without touching the DB.
     *
     * @param {Attendee[]} attendees - What loadAttendees returns.
     */
    async function expectStopped(attendees: Attendee[]) {
        scheduleWith({ "t-s2d": "sponsor_delegate" });
        loadAttendees.mockResolvedValue(attendees);

        const result = await runSchedulerForEvent("EVT");

        expect(result).toEqual({ ok: false, error: NO_ATTENDEES_MESSAGE });
        expect(dbDelete).not.toHaveBeenCalled();
        expect(dbInsert).not.toHaveBeenCalled();
    }

    test("stops and changes nothing when there are no sponsors", async () => {
        await expectStopped([DELEGATE]);
    });

    test("stops and changes nothing when there are no delegates", async () => {
        await expectStopped([SPONSOR]);
    });

    test("stops and changes nothing when no one loaded, as when Cvent's attendee lookup fails", async () => {
        await expectStopped([]);
    });

    test("stops when every delegate cancelled in Cvent, since the scheduler leaves them out", async () => {
        await expectStopped([
            SPONSOR,
            att({ salesforceId: "d1", role: "delegate", cventCancelled: true }),
        ]);
    });

    test("still runs normally with a sponsor and a delegate", async () => {
        scheduleWith({ "t-s2d": "sponsor_delegate" });
        loadAttendees.mockResolvedValue([SPONSOR, DELEGATE]);

        const result = await runSchedulerForEvent("EVT");

        expect(result.ok).toBe(true);
        expect(dbDelete).toHaveBeenCalledTimes(1);
        expect(insertValues).toHaveBeenCalledTimes(1);
    });
});
