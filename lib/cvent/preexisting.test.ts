import { describe, test, expect } from "vitest";
import { preexistingFromAppointments } from "./preexisting";
import { pairKey } from "@/lib/scheduling/helpers";
import type { Attendee } from "@/types";

// ---------------------------------------------------------------------------
// Reconciliation: Cvent participants → party-keyed pre-existing schedule.
// ---------------------------------------------------------------------------

/** Minimal attendee builder for these tests. */
function att(
    partial: Pick<Attendee, "id" | "role"> & Partial<Attendee>,
): Attendee {
    return {
        id: partial.id,
        cventContactId: partial.cventContactId ?? "",
        salesforceId: partial.salesforceId ?? partial.id,
        accountId: partial.accountId ?? "",
        name: partial.id,
        email: "",
        phone: "",
        role: partial.role,
        company: partial.company ?? "",
        title: "",
        sponsorTier: partial.role === "sponsor" ? "standard" : null,
        formFields: [],
        scheduling: { maxSameCompanyMeetings: partial.role === "sponsor" ? null : 2 },
    };
}

describe("preexistingFromAppointments", () => {
    test("collapses a multi-host appointment to one company↔delegate pair", () => {
        // Two reps of one company (hosts h1/h2) + one delegate (cd1).
        const attendees = [
            att({ id: "s1", role: "sponsor", accountId: "acct-acme", cventContactId: "h1" }),
            att({ id: "s2", role: "sponsor", accountId: "acct-acme", cventContactId: "h2" }),
            att({ id: "d1", role: "delegate", salesforceId: "d1-sf", cventContactId: "cd1" }),
        ];
        const appointments = [
            { startTime: "2025-01-15T09:00:00Z", participantContactIds: ["h1", "h2", "cd1"] },
        ];

        const { pairs, busyStartTimesByAttendee } = preexistingFromAppointments(
            appointments,
            attendees,
        );

        // Only the company↔delegate pair — no rep↔rep pair from the shared hosts.
        expect([...(pairs ?? [])]).toEqual([pairKey("acct-acme", "d1-sf")]);

        // Busy times keyed by party id: the company account and the delegate.
        expect([...(busyStartTimesByAttendee ?? new Map()).keys()].sort()).toEqual(
            ["acct-acme", "d1-sf"].sort(),
        );
        expect(busyStartTimesByAttendee?.get("acct-acme")).toEqual(
            new Set(["2025-01-15T09:00:00Z"]),
        );
    });

    test("ignores participants that don't map to a known attendee", () => {
        const attendees = [
            att({ id: "s1", role: "sponsor", accountId: "acct-acme", cventContactId: "h1" }),
            att({ id: "d1", role: "delegate", salesforceId: "d1-sf", cventContactId: "cd1" }),
        ];
        const appointments = [
            { startTime: "2025-01-15T09:00:00Z", participantContactIds: ["h1", "cd1", "stranger"] },
        ];

        const { pairs } = preexistingFromAppointments(appointments, attendees);
        expect([...(pairs ?? [])]).toEqual([pairKey("acct-acme", "d1-sf")]);
    });
});
