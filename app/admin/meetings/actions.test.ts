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
                where: async () => (table === meetingRequestsTable() ? REQUESTS : PUSHED),
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
// The event's Cvent appointments. None by default.
const getEventAppointments = vi.fn();
vi.mock("@/lib/cvent/client", () => ({
    getEventAppointments: (...a: unknown[]) => getEventAppointments(...a),
    cancelAppointment: vi.fn(),
}));
vi.mock("@/lib/cvent/push", () => ({
    pushMeetingRows: vi.fn(),
    needsSync: vi.fn(),
}));
// No manual booth mapping by default, so each sponsor's booth is matched by location name.
const getEventSettings = vi.fn();
vi.mock("@/lib/events/settings", () => ({
    getEventSettings: (...a: unknown[]) => getEventSettings(...a),
}));

import {
    countBoothProblemsForEvent,
    listSponsorsPage,
    runSchedulerForEvent,
} from "./actions";
import { BOOTH_MAPPING_UNAVAILABLE_MESSAGE } from "@/lib/scheduling/boothData";
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

// Meetings already pushed to Cvent, as scheduled_meetings rows. None by default.
let PUSHED: { attendeeA: string; attendeeB: string; timeslotId: string; cventAppointmentId: string }[] = [];

// One sponsor request from Acme to Dee by default.
const ONE_REQUEST = [
    { id: 1, requesterId: "acct-acme", targetId: "d1", rank: 5, eventCode: "EVT" },
];
let REQUESTS = ONE_REQUEST;

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
        cventContactId: partial.cventContactId ?? "",
        cventCancelled: partial.cventCancelled,
        salesforceId: partial.salesforceId,
        accountId: partial.accountId ?? "",
        name: partial.name ?? partial.salesforceId,
        email: "",
        phone: "",
        role: partial.role,
        company: partial.company ?? "",
        title: "",
        sponsorTier: partial.sponsorTier ?? (partial.role === "sponsor" ? "standard" : null),
        opportunityId: partial.opportunityId,
        boothNo: partial.boothNo,
        purchasedMeetings: partial.purchasedMeetings,
        bonusMeetings: partial.bonusMeetings,
        maximumMeetings: partial.maximumMeetings,
        meetingsAtOnce: partial.meetingsAtOnce,
        profile: emptyProfile(),
        scheduling: {
            maxSameCompanyMeetings: partial.role === "sponsor" ? null : 2,
            requestedSponsorAccountIds: [],
        },
    };
}

// Every slot is at loc-1, which is Acme's booth.
const BOOTH_1 = { id: "loc-1", name: "Booth 1", capacity: Infinity, parentLocationId: null };

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
        locations: [BOOTH_1],
        timeslotById: new Map(timeslots.map((t) => [t.id, t])),
        locationById: new Map([[BOOTH_1.id, BOOTH_1]]),
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
    getEventSettings.mockResolvedValue({ boothLocations: null });
    getEventAppointments.mockResolvedValue([]);
    PUSHED = [];
    REQUESTS = ONE_REQUEST;
    loadAttendees.mockResolvedValue([
        att({ salesforceId: "s1", role: "sponsor", accountId: "acct-acme", company: "Acme", boothNo: "1" }),
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
    const SPONSOR = att({ salesforceId: "s1", role: "sponsor", accountId: "acct-acme", company: "Acme", boothNo: "1" });
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

describe("runSchedulerForEvent — booths", () => {
    test("stops and changes nothing when the booth mapping can't be read", async () => {
        scheduleWith({ "t-s2d": "sponsor_delegate" });
        getEventSettings.mockRejectedValue(new Error("db down"));

        const result = await runSchedulerForEvent("EVT");

        expect(result).toEqual({ ok: false, error: BOOTH_MAPPING_UNAVAILABLE_MESSAGE });
        expect(dbDelete).not.toHaveBeenCalled();
        expect(dbInsert).not.toHaveBeenCalled();
    });

    test("gives a sponsor with no booth no meetings and lists it in the report", async () => {
        scheduleWith({ "t-s2d": "sponsor_delegate" });
        loadAttendees.mockResolvedValue([
            att({ salesforceId: "s1", role: "sponsor", accountId: "acct-acme", company: "Acme" }),
            att({ salesforceId: "d1", role: "delegate", name: "Dee", company: "Globex" }),
        ]);

        const result = await runSchedulerForEvent("EVT");

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.report.meetingsScheduled).toBe(0);
        expect(result.report.unscheduledRequests.map((u) => u.reason)).toEqual(["no_booth"]);
        expect(result.report.boothProblems.map((p) => [p.company, p.problem])).toEqual([["Acme", "no_booth"]]);
    });

    test("uses the manual mapping from Event settings", async () => {
        scheduleWith({ "t-s2d": "sponsor_delegate" });
        // Acme's booth number 7 matches nothing by name, but is mapped to loc-1 by hand.
        getEventSettings.mockResolvedValue({ boothLocations: { "7": "loc-1" } });
        loadAttendees.mockResolvedValue([
            att({ salesforceId: "s1", role: "sponsor", accountId: "acct-acme", company: "Acme", boothNo: "7" }),
            att({ salesforceId: "d1", role: "delegate", name: "Dee", company: "Globex" }),
        ]);

        const result = await runSchedulerForEvent("EVT");

        expect(result.ok && result.report.meetingsScheduled).toBe(1);
    });
});

describe("runSchedulerForEvent — existing meetings count toward the maximum", () => {
    test("a maximum of 5 with 5 meetings already pushed gets no new meetings", async () => {
        scheduleWith({ "t-s2d": "sponsor_delegate" });
        loadAttendees.mockResolvedValue([
            att({ salesforceId: "s1", role: "sponsor", accountId: "acct-acme", company: "Acme", boothNo: "1", maximumMeetings: 5 }),
            att({ salesforceId: "d1", role: "delegate", name: "Dee", company: "Globex" }),
        ]);
        // Five pushed meetings with other delegates, at times the run doesn't use.
        // Cvent's appointment list is empty here, as in mock mode, so the DB rows are what count.
        PUSHED = Array.from({ length: 5 }, (_, i) => ({
            attendeeA: "acct-acme",
            attendeeB: `d-old-${i}`,
            timeslotId: `old-${i}`,
            cventAppointmentId: `appt-${i}`,
        }));

        const result = await runSchedulerForEvent("EVT");

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.report.meetingsScheduled).toBe(0);
        expect(result.report.unscheduledRequests.map((u) => u.reason)).toEqual(["cap_reached"]);
    });
});

describe("runSchedulerForEvent — pushed meetings listed in both Cvent and the DB", () => {
    test("counts them once, so a maximum of 5 with 3 pushed books 2 more", async () => {
        const kinds: AppointmentTypeKinds = { "t-s2d": "sponsor_delegate" };
        const times = ["2026-01-20T10:00:00Z", "2026-01-20T11:00:00Z", "2026-01-20T12:00:00Z"];
        scheduleWith(kinds, times.map((t, i) => slot(`ts-${i}`, t, "t-s2d", kinds)));
        loadAttendees.mockResolvedValue([
            att({ salesforceId: "s1", role: "sponsor", accountId: "acct-acme", company: "Acme", boothNo: "1", maximumMeetings: 5, cventContactId: "h-acme" }),
            ...["d1", "d2", "d3"].map((id) => att({ salesforceId: id, role: "delegate" })),
        ]);
        REQUESTS = ["d1", "d2", "d3"].map((d, i) => ({ id: i + 1, requesterId: "acct-acme", targetId: d, rank: 5, eventCode: "EVT" }));

        // The same 3 pushed meetings, as DB rows and as Cvent appointments, at times the run doesn't use.
        PUSHED = [0, 1, 2].map((i) => ({
            attendeeA: "acct-acme",
            attendeeB: `d-old-${i}`,
            timeslotId: `old-${i}`,
            cventAppointmentId: `appt-${i}`,
        }));
        getEventAppointments.mockResolvedValue(
            [0, 1, 2].map((i) => ({
                id: `appt-${i}`,
                startTime: `2026-01-20T0${i + 6}:00:00Z`,
                participantContactIds: ["h-acme", `cd-old-${i}`],
                hostContactIds: ["h-acme"],
                locationName: "Booth 1",
            })),
        );

        const result = await runSchedulerForEvent("EVT");

        expect(result.ok && result.report.meetingsScheduled).toBe(2);
    });
});

describe("runSchedulerForEvent — Cvent's appointment list can't be read", () => {
    test("takes pushed meetings off their slot's room, so a full 1-per-slot booth gets no second meeting", async () => {
        const kinds: AppointmentTypeKinds = { "t-s2d": "sponsor_delegate" };
        // One slot at Booth 1, 1 per slot, already holding a pushed Acme meeting.
        scheduleWith(kinds, [{ ...slot("ts-s2d", "2026-01-20T10:00:00Z", "t-s2d", kinds), capacity: 1 }]);
        getEventAppointments.mockRejectedValue(new Error("Cvent down"));
        loadAttendees.mockResolvedValue([
            att({ salesforceId: "s1", role: "sponsor", accountId: "acct-acme", company: "Acme", boothNo: "1", meetingsAtOnce: 2, cventContactId: "h1" }),
            att({ salesforceId: "s2", role: "sponsor", accountId: "acct-acme", company: "Acme", boothNo: "1", meetingsAtOnce: 2, cventContactId: "h2" }),
            att({ salesforceId: "d1", role: "delegate", name: "Dee", company: "Globex" }),
        ]);
        PUSHED = [{ attendeeA: "acct-acme", attendeeB: "d-old", timeslotId: "ts-s2d", cventAppointmentId: "appt-old" }];

        const result = await runSchedulerForEvent("EVT");

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.report.meetingsScheduled).toBe(0);
        expect(result.report.unscheduledRequests.map((u) => u.reason)).toEqual(["no_availability"]);
    });
});

describe("countBoothProblemsForEvent", () => {
    test("counts the companies with a booth problem, for the warning before a run", async () => {
        scheduleWith({ "t-s2d": "sponsor_delegate" });
        loadAttendees.mockResolvedValue([
            att({ salesforceId: "s1", role: "sponsor", accountId: "acct-acme", company: "Acme", boothNo: "1" }),
            att({ salesforceId: "s2", role: "sponsor", accountId: "acct-beta", company: "Beta" }),
            att({ salesforceId: "s3", role: "sponsor", accountId: "acct-gamma", company: "Gamma", boothNo: "99" }),
        ]);

        expect(await countBoothProblemsForEvent("EVT")).toBe(2);
    });

    test("returns null when the booths can't be checked", async () => {
        scheduleWith({ "t-s2d": "sponsor_delegate" });
        getEventSettings.mockRejectedValue(new Error("db down"));

        expect(await countBoothProblemsForEvent("EVT")).toBeNull();
    });
});

describe("listSponsorsPage — Salesforce meeting counts", () => {
    test("shows purchased, bonus and maximum with the scheduler's rule, including the tier fallback", async () => {
        scheduleWith({ "t-s2d": "sponsor_delegate" });
        loadAttendees.mockResolvedValue([
            att({ salesforceId: "s1", role: "sponsor", accountId: "acct-acme", company: "Acme", purchasedMeetings: 3, bonusMeetings: 2 }),
            att({ salesforceId: "s2", role: "sponsor", accountId: "acct-beta", company: "Beta", purchasedMeetings: 4, maximumMeetings: 6 }),
            att({ salesforceId: "s3", role: "sponsor", accountId: "acct-dia", company: "Diamond Co", sponsorTier: "diamond" }),
            att({ salesforceId: "s4", role: "sponsor", accountId: "acct-exh", company: "Exhibitor", purchasedMeetings: 0 }),
        ]);

        const page = await listSponsorsPage({ eventCode: "EVT", sortDir: "asc" });
        const byCompany = new Map(page.rows.map((r) => [r.company, r]));

        expect(byCompany.get("Acme")).toMatchObject({ purchased: 3, bonus: 2, maximum: 5, maximumFromTier: false, requestCount: 1 });
        expect(byCompany.get("Beta")).toMatchObject({ purchased: 4, bonus: null, maximum: 6, maximumFromTier: false });
        expect(byCompany.get("Diamond Co")).toMatchObject({ purchased: null, bonus: null, maximum: 8, maximumFromTier: true });
        expect(byCompany.get("Exhibitor")).toMatchObject({ purchased: 0, maximum: 0, maximumFromTier: false });
    });
});

describe("listSponsorsPage — appointments only in Cvent", () => {
    test("counts a company's Cvent appointments this database has no meeting for, and not ones it has", async () => {
        loadAttendees.mockResolvedValue([
            att({ salesforceId: "s1", role: "sponsor", accountId: "acct-acme", company: "Acme", cventContactId: "h-acme" }),
            att({ salesforceId: "d1", role: "delegate", name: "Dee", company: "Globex", cventContactId: "c-d1" }),
        ]);
        // One pushed from here, and two pushed from another environment.
        PUSHED = [{ attendeeA: "acct-acme", attendeeB: "d1", timeslotId: "ts-1", cventAppointmentId: "appt-here" }];
        getEventAppointments.mockResolvedValue(
            ["appt-here", "appt-other-1", "appt-other-2"].map((id, i) => ({
                id,
                startTime: `2026-01-20T0${i + 6}:00:00Z`,
                participantContactIds: ["h-acme", "c-d1"],
                hostContactIds: ["h-acme"],
                locationName: "Booth 1",
            })),
        );

        const page = await listSponsorsPage({ eventCode: "EVT" });

        expect(page.rows.find((r) => r.company === "Acme")?.scheduledCount).toBe(3);
    });

    test("still lists sponsors when Cvent can't be read", async () => {
        getEventAppointments.mockRejectedValue(new Error("Cvent down"));
        PUSHED = [{ attendeeA: "acct-acme", attendeeB: "d1", timeslotId: "ts-1", cventAppointmentId: "appt-here" }];

        const page = await listSponsorsPage({ eventCode: "EVT" });

        expect(page.rows.find((r) => r.company === "Acme")?.scheduledCount).toBe(1);
    });
});
