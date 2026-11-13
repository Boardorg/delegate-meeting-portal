import { describe, test, expect } from "vitest";
import type { EventSettingsRow } from "@/lib/db/schema";
import { summarizeSetup, summarizeRequests, summarizeMeetings } from "./overview";

/**
 * Builds an event settings row with every required field filled in.
 *
 * @param {Partial<EventSettingsRow>} overrides - Fields to change.
 * @returns {EventSettingsRow} The row.
 */
function event(overrides: Partial<EventSettingsRow> = {}): EventSettingsRow {
    return {
        id: 1,
        code: "NALES",
        name: "NALES 2027",
        themeColor: "#7985b9",
        logoUrl: "https://example.test/logo.png",
        cventEventId: "evt-1",
        cventAppointmentEventId: "appt-evt-1",
        appointmentTypeKinds: { "type-s2d": "sponsor_delegate" },
        boothLocations: null,
        createdAt: new Date("2026-11-01T00:00:00Z"),
        updatedAt: new Date("2026-11-01T00:00:00Z"),
        ...overrides,
    } as EventSettingsRow;
}

/**
 * Builds a meeting row's sync fields.
 *
 * @param {string | null} apptId - The Cvent appointment id, or null when not pushed.
 * @param {string | null} modified - ISO time of the last edit.
 * @param {string | null} pushed - ISO time of the last push.
 * @returns {{ cventAppointmentId: string | null; lastModifiedAt: Date | null; lastPushedAt: Date | null }} The fields.
 */
function meeting(apptId: string | null, modified: string | null = null, pushed: string | null = null) {
    return {
        cventAppointmentId: apptId,
        lastModifiedAt: modified ? new Date(modified) : null,
        lastPushedAt: pushed ? new Date(pushed) : null,
    };
}

describe("summarizeSetup", () => {
    test("reports nothing missing for a complete event with the sponsor type mapped", () => {
        expect(summarizeSetup(event())).toEqual({ missingFields: [], sponsorTypeMapped: true });
    });

    test("lists blank required fields by their labels", () => {
        const summary = summarizeSetup(event({ logoUrl: null, cventAppointmentEventId: "  " }));
        expect(summary.missingFields).toEqual(["Logo URL", "Cvent Appointment Event ID"]);
    });

    test("warns when no appointment type is mapped to sponsor-to-delegate", () => {
        expect(summarizeSetup(event({ appointmentTypeKinds: null })).sponsorTypeMapped).toBe(false);
        expect(
            summarizeSetup(event({ appointmentTypeKinds: { "type-d2d": "delegate_delegate" } }))
                .sponsorTypeMapped,
        ).toBe(false);
    });
});

describe("summarizeRequests", () => {
    test("counts requests and the distinct companies that made them", () => {
        expect(
            summarizeRequests([{ requesterId: "acct-a" }, { requesterId: "acct-a" }, { requesterId: "acct-b" }]),
        ).toEqual({ requests: 3, companies: 2 });
    });
});

describe("summarizeMeetings", () => {
    test("counts each sync status and adds meetings only in Cvent to the scheduled total", () => {
        const rows = [
            meeting(null),
            meeting("a1", null, "2026-11-02T00:00:00Z"),
            meeting("a2", "2026-11-03T00:00:00Z", "2026-11-02T00:00:00Z"),
        ];
        expect(summarizeMeetings(rows, 2)).toEqual({
            scheduled: 5,
            synced: 1,
            modified: 1,
            notPushed: 1,
            onlyInCvent: 2,
        });
    });

    test("keeps the database counts when Cvent couldn't be read", () => {
        expect(summarizeMeetings([meeting(null)], null)).toMatchObject({ scheduled: 1, onlyInCvent: null });
    });
});
