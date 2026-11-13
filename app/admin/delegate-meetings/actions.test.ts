import { describe, test, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Attendee, Timeslot } from "@/types";
import type { ScheduledMeetingRow } from "@/lib/db/schema";
import type { MatchingContext } from "@/lib/matching/data";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { DEFAULT_MATCHING_SETTINGS } from "@/lib/matching/settings";
import { cventOnlyForDelegates, delegateMeetingCounts } from "@/lib/matching/delegateMeetings";

// ---------------------------------------------------------------------------
// runD2DForEvent. The matching data, the DB and Cvent are mocked.
// The tests check what the run deletes and inserts.
// ---------------------------------------------------------------------------

const loadMatchingContext = vi.fn();
const deleteWhere = vi.fn<(cond: SQL) => Promise<void>>(async () => undefined);
const insertValues = vi.fn<(rows: unknown) => Promise<void>>(async () => undefined);
const selectWhere = vi.fn<(cond: SQL) => void>();

vi.mock("@/lib/matching/data", () => ({
    loadMatchingContext: (...a: unknown[]) => loadMatchingContext(...a),
}));
vi.mock("@/lib/db/client", () => ({
    db: {
        delete: () => ({
            where: (cond: SQL) => Object.assign(deleteWhere(cond), { returning: async () => [] }),
        }),
        select: () => ({
            from: () => ({
                where: async (cond: SQL) => {
                    selectWhere(cond);
                    return [];
                },
            }),
        }),
        insert: () => ({ values: (rows: unknown) => insertValues(rows) }),
    },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/cvent/push", () => ({ needsSync: vi.fn(), pushDelegateMeetingRows: vi.fn() }));
vi.mock("@/lib/cvent/unpush", () => ({
    unpushMeetingRows: vi.fn(async () => ({ unpushed: 0, alreadyGone: 0, failures: [], notes: [] })),
}));

import { clearUnsyncedD2DForEvent, runD2DForEvent, unpushAllD2DForEvent } from "./actions";
import { NO_D2D_SLOTS_MESSAGE } from "@/lib/matching/d2d";

/**
 * Builds an eligible delegate who shares an interest with every other.
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
        company: `Company ${id}`,
        title: "",
        sponsorTier: null,
        networkingProfileComplete: true,
        conferenceOnly: false,
        profile: { ...emptyProfile(), meetingInterests: ["Leadership Development"] },
        scheduling: { maxSameCompanyMeetings: 2, requestedSponsorAccountIds: [] },
    };
}

/**
 * Builds a Day 1 delegate_delegate slot.
 *
 * @param {string} id - The timeslot id.
 * @param {string} hhmm - The start time.
 * @returns {Timeslot} The slot.
 */
function slot(id: string, hhmm: string): Timeslot {
    const start = `2027-01-20T${hhmm}:00.000Z`;
    return { id, day: 1, startTime: start, endTime: start, capacity: 10, locationId: "loc", appointmentTypeId: "t", appointmentTypeName: "D2D", kind: "delegate_delegate" };
}

/**
 * Builds a scheduled_meetings row.
 *
 * @param {Partial<ScheduledMeetingRow>} partial - The fields to set.
 * @returns {ScheduledMeetingRow} The row.
 */
function row(partial: Partial<ScheduledMeetingRow>): ScheduledMeetingRow {
    return {
        id: "m",
        eventCode: "EVT",
        kind: "delegate_delegate",
        attendeeA: "",
        attendeeB: "",
        day: 1,
        timeslotId: "t1",
        passNumber: 6,
        mutual: false,
        matchKind: "profile_match",
        rank: null,
        source: "portal",
        locationId: "loc",
        cventAppointmentId: null,
        lastModifiedAt: null,
        lastPushedAt: null,
        createdAt: new Date(0),
        ...partial,
    };
}

/**
 * Builds the matching data for a run.
 *
 * @param {ScheduledMeetingRow[]} rows - The event's meetings.
 * @param {Timeslot[]} timeslots - The event's slots.
 * @returns {MatchingContext} The data.
 */
function context(
    rows: ScheduledMeetingRow[],
    timeslots: Timeslot[],
    seats: { roundtableId: string; delegateId: string; timeslotId: string }[] = [],
): MatchingContext {
    const attendees = ["d1", "d2", "d3", "d4"].map(delegate);
    const cventOnly = cventOnlyForDelegates([], attendees, new Set());
    return {
        attendees,
        scheduleData: {
            timeslots,
            locations: [],
            timeslotById: new Map(timeslots.map((t) => [t.id, t])),
            locationById: new Map(),
            timezone: "UTC",
            appointmentTypes: [],
            appointmentTypeKinds: null,
        },
        settings: DEFAULT_MATCHING_SETTINGS,
        rows,
        roundtableRows: seats.map((s) => ({
            id: s.roundtableId,
            eventCode: "EVT",
            timeslotId: s.timeslotId,
            locationId: null,
            themeTitle: null,
            discussionPrompt: null,
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
        cventOnly,
        counts: delegateMeetingCounts(rows, cventOnly),
    };
}

/**
 * Renders a drizzle condition as SQL text, so a test can read what a delete targets.
 *
 * @param {SQL} cond - The condition.
 * @returns {string} The SQL text.
 */
function sqlText(cond: SQL): string {
    return new PgDialect().sqlToQuery(cond).sql;
}

/**
 * Renders a drizzle condition and returns its bound values.
 *
 * @param {SQL} cond - The condition.
 * @returns {unknown[]} The values, in order.
 */
function sqlParams(cond: SQL): unknown[] {
    return new PgDialect().sqlToQuery(cond).params;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("runD2DForEvent", () => {
    test("criterion 13: re-running replaces unpushed D2D meetings and keeps pushed ones", async () => {
        const slots = [slot("t1", "09:00"), slot("t2", "10:00"), slot("t3", "11:00")];
        loadMatchingContext.mockResolvedValue(
            context(
                [
                    // Pushed: d1 and d2 already meet at t1.
                    row({ id: "pushed", attendeeA: "d1", attendeeB: "d2", cventAppointmentId: "appt-1" }),
                    // Unpushed: replaced by the run.
                    row({ id: "old", attendeeA: "d3", attendeeB: "d4" }),
                ],
                slots,
            ),
        );

        const result = await runD2DForEvent("EVT");

        expect(result.ok).toBe(true);
        // Only this event's unpushed portal D2D meetings are deleted.
        expect(deleteWhere).toHaveBeenCalledTimes(1);
        const where = sqlText(deleteWhere.mock.calls[0][0]);
        expect(where).toContain('"kind" = $');
        expect(where).toContain('"cvent_appointment_id" is null');
        expect(where).toContain('"source" = $');
        expect(sqlParams(deleteWhere.mock.calls[0][0])).toEqual(["EVT", "portal", "delegate_delegate"]);

        // The new meetings are D2D, never repeat the pushed pair, and avoid its time for d1 and d2.
        const inserted = insertValues.mock.calls[0][0] as ScheduledMeetingRow[];
        expect(inserted.length).toBeGreaterThan(0);
        expect(inserted.every((m) => m.kind === "delegate_delegate" && m.cventAppointmentId === null)).toBe(true);
        expect(inserted.some((m) => m.attendeeA === "d1" && m.attendeeB === "d2")).toBe(false);
        for (const m of inserted) {
            if ([m.attendeeA, m.attendeeB].some((id) => id === "d1" || id === "d2")) {
                expect(m.timeslotId).not.toBe("t1");
            }
        }
        if (result.ok) expect(result.report.kept).toBe(1);
    });

    test("criterion 22: running before any S2D meetings exist warns but still runs", async () => {
        loadMatchingContext.mockResolvedValue(context([], [slot("t1", "09:00")]));

        const result = await runD2DForEvent("EVT");

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.report.warnings.join(" ")).toMatch(/No sponsor meetings are scheduled yet/);
            expect(result.report.created).toBeGreaterThan(0);
        }
        expect(insertValues).toHaveBeenCalled();
    });

    test("criterion 9: S2D meetings count as busy, so D2D avoids their times", async () => {
        const slots = [slot("t1", "09:00"), slot("t2", "10:00")];
        loadMatchingContext.mockResolvedValue(
            context(
                [row({ id: "s2d", kind: "sponsor_delegate", attendeeA: "acct-x", attendeeB: "d1", timeslotId: "t1", matchKind: "sponsor_choice" })],
                slots,
            ),
        );

        await runD2DForEvent("EVT");

        const inserted = insertValues.mock.calls[0][0] as ScheduledMeetingRow[];
        for (const m of inserted) {
            if (m.attendeeA === "d1" || m.attendeeB === "d1") expect(m.timeslotId).toBe("t2");
        }
    });

    test("stops without changing anything when no slot is mapped to delegate_delegate", async () => {
        loadMatchingContext.mockResolvedValue(context([], [{ ...slot("t1", "09:00"), kind: "sponsor_delegate" }]));

        const result = await runD2DForEvent("EVT");

        expect(result).toEqual({ ok: false, error: NO_D2D_SLOTS_MESSAGE });
        expect(deleteWhere).not.toHaveBeenCalled();
    });
});

describe("runD2DForEvent: roundtable seats", () => {
    test("decisions 1 and 3: a delegate seated at a roundtable isn't paired, and the run warns", async () => {
        const slots = [slot("t1", "09:00"), slot("t2", "10:00")];
        loadMatchingContext.mockResolvedValue(context([], slots, [{ roundtableId: "rt", delegateId: "d1", timeslotId: "t9" }]));

        const result = await runD2DForEvent("EVT");

        const inserted = insertValues.mock.calls[0][0] as ScheduledMeetingRow[];
        expect(inserted.some((m) => m.attendeeA === "d1" || m.attendeeB === "d1")).toBe(false);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.report.excluded.seatedAtRoundtable).toBe(1);
        expect(result.report.warnings.join(" ")).toMatch(/Roundtables are already grouped/);
    });
});

describe("D2D bulk actions only touch D2D meetings", () => {
    test("Clear All Unsynced deletes only this event's unpushed D2D meetings", async () => {
        await clearUnsyncedD2DForEvent("EVT");

        const cond = deleteWhere.mock.calls[0][0];
        expect(sqlParams(cond)).toEqual(["EVT", "portal", "delegate_delegate"]);
        expect(sqlText(cond)).toContain('"cvent_appointment_id" is null');
    });

    test("Unpush All Synced reads only this event's synced D2D meetings", async () => {
        loadMatchingContext.mockResolvedValue(context([], []));

        await unpushAllD2DForEvent("EVT");

        const cond = selectWhere.mock.calls[0][0];
        expect(sqlParams(cond)).toEqual(["EVT", "portal", "delegate_delegate"]);
        expect(sqlText(cond)).toContain('"cvent_appointment_id" is not null');
    });
});
