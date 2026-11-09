import { describe, test, expect } from "vitest";
import { preexistingFromAppointments } from "./preexisting";
import { pairKey, slotRoomKey } from "@/lib/scheduling/helpers";
import type { Attendee } from "@/types";
import type { CventExistingAppointment } from "@/lib/cvent/client";
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

/**
 * Builds an existing Cvent appointment.
 *
 * @param {string} startTime - ISO start time.
 * @param {string[]} participantContactIds - Hosts and attendees.
 * @param {string[]} [hostContactIds] - The hosts among them. Defaults to none.
 * @param {string | null} [locationName] - The location name. Defaults to none.
 * @returns {CventExistingAppointment} The appointment.
 */
function appt(
    startTime: string,
    participantContactIds: string[],
    hostContactIds: string[] = [],
    locationName: string | null = null,
): CventExistingAppointment {
    return { id: null, startTime, participantContactIds, hostContactIds, locationName };
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
            appt("2025-01-15T09:00:00Z", ["h1", "h2", "cd1"]),
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
            new Map([["2025-01-15T09:00:00.000Z", 1]]),
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
            appt("2025-01-15T09:00:00Z", ["h1", "cd1"]),
            appt("2025-01-15T09:00:00Z", ["h2", "cd2"]),
            appt("2025-01-15T10:00:00Z", ["h1", "h2", "cd1"]),
        ];

        const { busyStartTimesByAttendee } = preexistingFromAppointments(appointments, attendees);

        expect(busyStartTimesByAttendee?.get("acct-acme")).toEqual(
            new Map([
                ["2025-01-15T09:00:00.000Z", 2],
                ["2025-01-15T10:00:00.000Z", 1],
            ]),
        );
        expect(busyStartTimesByAttendee?.get("d1-sf")).toEqual(
            new Map([
                ["2025-01-15T09:00:00.000Z", 1],
                ["2025-01-15T10:00:00.000Z", 1],
            ]),
        );
    });

    test("ignores participants that don't map to a known attendee", () => {
        const attendees = [
            att({ id: "s1", role: "sponsor", accountId: "acct-acme", cventContactId: "h1" }),
            att({ id: "d1", role: "delegate", salesforceId: "d1-sf", cventContactId: "cd1" }),
        ];
        const appointments = [
            appt("2025-01-15T09:00:00Z", ["h1", "cd1", "stranger"]),
        ];

        const { pairs } = preexistingFromAppointments(appointments, attendees);
        expect([...(pairs ?? [])]).toEqual([pairKey("acct-acme", "d1-sf")]);
    });

    test("counts each party's appointments, for its maximum", () => {
        const attendees = [
            att({ id: "s1", role: "sponsor", accountId: "acct-acme", cventContactId: "h1" }),
            att({ id: "d1", role: "delegate", salesforceId: "d1-sf", cventContactId: "cd1" }),
        ];
        const appointments = [
            appt("2025-01-15T09:00:00Z", ["h1", "cd1"]),
            appt("2025-01-15T10:00:00Z", ["h1"]),
        ];

        const { meetingCountByParty } = preexistingFromAppointments(appointments, attendees);

        expect(meetingCountByParty?.get("acct-acme")).toBe(2);
        expect(meetingCountByParty?.get("d1-sf")).toBe(1);
    });

    test("records which of a company's reps host at each start time", () => {
        const attendees = [
            att({ id: "s1", role: "sponsor", accountId: "acct-acme", cventContactId: "h1" }),
            att({ id: "s2", role: "sponsor", accountId: "acct-acme", cventContactId: "h2" }),
            att({ id: "d1", role: "delegate", salesforceId: "d1-sf", cventContactId: "cd1" }),
        ];
        const appointments = [appt("2025-01-15T09:00:00Z", ["h1", "cd1"], ["h1"])];

        const { busyHostsByParty } = preexistingFromAppointments(appointments, attendees);

        expect(busyHostsByParty?.get("acct-acme")?.get("2025-01-15T09:00:00.000Z")).toEqual(new Set(["h1"]));
        // The delegate is an attendee, not a host.
        expect(busyHostsByParty?.has("d1-sf")).toBe(false);
    });

    test("counts appointments at each location and start time, matched by location name", () => {
        const appointments = [
            appt("2025-01-15T09:00:00Z", [], [], "Booth 13"),
            appt("2025-01-15T09:00:00.000Z", [], [], "booth 13 "),
            appt("2025-01-15T10:00:00Z", [], [], "Booth 13"),
        ];

        const { bookedBySlot } = preexistingFromAppointments(appointments, []);

        expect(bookedBySlot?.get(slotRoomKey("Booth 13", "2025-01-15T09:00:00.000Z"))).toBe(2);
        expect(bookedBySlot?.get(slotRoomKey("Booth 13", "2025-01-15T10:00:00.000Z"))).toBe(1);
    });
});
