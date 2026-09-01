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
const cancelAppointment = vi.fn();
const loadAttendees = vi.fn();
const loadEventScheduleData = vi.fn();

vi.mock("@/lib/cvent/client", () => ({
    createAppointment: (...a: unknown[]) => createAppointment(...a),
    cancelAppointment: (...a: unknown[]) => cancelAppointment(...a),
}));
vi.mock("@/lib/attendees/loader", () => ({
    loadAttendees: (...a: unknown[]) => loadAttendees(...a),
}));
vi.mock("@/lib/cvent/mapper", () => ({
    loadEventScheduleData: (...a: unknown[]) => loadEventScheduleData(...a),
}));
vi.mock("@/lib/db/client", () => ({
    db: { update: () => ({ set: () => ({ where: async () => undefined }) }) },
}));

import { pushMeetingRows } from "./push";

/** Minimal attendee builder. */
function att(
    partial: Pick<Attendee, "id" | "role"> & Partial<Attendee>,
): Attendee {
    return {
        id: partial.id,
        cventContactId: partial.cventContactId ?? "",
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
        scheduling: { maxSameCompanyMeetings: partial.role === "sponsor" ? null : 2 },
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
    loadEventScheduleData.mockResolvedValue({
        timeslotById: new Map([
            [
                "ts-1",
                {
                    startTime: "2025-01-15T09:00:00Z",
                    endTime: "2025-01-15T09:30:00Z",
                    appointmentTypeId: "type-1",
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
