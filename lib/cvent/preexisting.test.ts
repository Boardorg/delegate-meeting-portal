import { describe, test, expect } from "vitest";
import { preexistingFromAppointments } from "./preexisting";
import { pairKey } from "@/lib/scheduling/helpers";
import type { Attendee } from "@/types";
import { emptyProfile } from "@/lib/attendees/formatProfile";

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
        profile: emptyProfile(),
        scheduling: {
            maxSameCompanyMeetings: partial.role === "sponsor" ? null : 2,
            requestedSponsorAccountIds: [],
        },
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
        // A count per start time, so it counts toward the company's meetings at once.
        expect(busyStartTimesByAttendee?.get("acct-acme")).toEqual(
            new Map([["2025-01-15T09:00:00Z", 1]]),
        );
    });

    test("counts each of a company's appointments at the same start time", () => {
        // Two appointments at 09:00, each hosted by a different rep of one company.
        const attendees = [
            att({ id: "s1", role: "sponsor", accountId: "acct-acme", cventContactId: "h1" }),
            att({ id: "s2", role: "sponsor", accountId: "acct-acme", cventContactId: "h2" }),
            att({ id: "d1", role: "delegate", salesforceId: "d1-sf", cventContactId: "cd1" }),
            att({ id: "d2", role: "delegate", salesforceId: "d2-sf", cventContactId: "cd2" }),
        ];
        const appointments = [
            { startTime: "2025-01-15T09:00:00Z", participantContactIds: ["h1", "cd1"] },
            { startTime: "2025-01-15T09:00:00Z", participantContactIds: ["h2", "cd2"] },
            { startTime: "2025-01-15T10:00:00Z", participantContactIds: ["h1", "h2", "cd1"] },
        ];

        const { busyStartTimesByAttendee } = preexistingFromAppointments(appointments, attendees);

        expect(busyStartTimesByAttendee?.get("acct-acme")).toEqual(
            new Map([
                ["2025-01-15T09:00:00Z", 2],
                ["2025-01-15T10:00:00Z", 1],
            ]),
        );
        expect(busyStartTimesByAttendee?.get("d1-sf")).toEqual(
            new Map([
                ["2025-01-15T09:00:00Z", 1],
                ["2025-01-15T10:00:00Z", 1],
            ]),
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
