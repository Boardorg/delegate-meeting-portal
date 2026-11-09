import { describe, test, expect } from "vitest";
import type { Attendee } from "@/types";
import type { CventExistingAppointment } from "@/lib/cvent/client";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import {
    appointmentsNotInPortal,
    companyAppointmentsNotInPortal,
    countAppointmentsNotInPortal,
} from "./cventOnly";

// ---------------------------------------------------------------------------
// Cvent appointments this database has no meeting for.
// Modeled on Lakeside's 5 appointments pushed from another environment.
// ---------------------------------------------------------------------------

/**
 * Builds an attendee with a Cvent contact id of `c-<id>`.
 *
 * @param {string} id - The Salesforce id.
 * @param {"sponsor" | "delegate"} role - The role.
 * @param {string} accountId - The company's Account id.
 * @returns {Attendee} The attendee.
 */
function person(id: string, role: "sponsor" | "delegate", accountId: string): Attendee {
    return {
        id,
        cventContactId: `c-${id}`,
        salesforceId: id,
        accountId,
        name: `Name ${id}`,
        email: "",
        phone: "",
        role,
        company: accountId,
        title: "",
        sponsorTier: role === "sponsor" ? "standard" : null,
        opportunityId: role === "sponsor" ? `opp-${accountId}` : null,
        boothNo: null,
        purchasedMeetings: null,
        bonusMeetings: null,
        maximumMeetings: null,
        meetingsAtOnce: null,
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: null, requestedSponsorAccountIds: [] },
    };
}

/**
 * Builds an active Cvent appointment.
 *
 * @param {string | null} id - The appointment id.
 * @param {string} startTime - ISO start time.
 * @param {string[]} people - Salesforce ids of the participants. Unknown ids become unknown contacts.
 * @returns {CventExistingAppointment} The appointment.
 */
function appt(id: string | null, startTime: string, people: string[]): CventExistingAppointment {
    return {
        id,
        startTime,
        participantContactIds: people.map((p) => `c-${p}`),
        hostContactIds: [],
        locationName: "Booth 3",
    };
}

const ATTENDEES = [
    person("ronnie", "sponsor", "acct-lake"),
    person("bob", "sponsor", "acct-21m"),
    person("ted", "sponsor", "acct-21m"),
    person("whitney", "delegate", "acct-assemble"),
    person("xanthi", "delegate", "acct-testing"),
];

describe("appointmentsNotInPortal", () => {
    test("drops appointments this database already has, and keeps ones Cvent sent without an id", () => {
        const kept = appointmentsNotInPortal(
            [appt("a1", "2027-01-20T18:00:00Z", []), appt("a2", "2027-01-20T18:30:00Z", []), appt(null, "2027-01-20T19:00:00Z", [])],
            new Set(["a1"]),
        );
        expect(kept.map((a) => a.id)).toEqual(["a2", null]);
    });
});

describe("companyAppointmentsNotInPortal", () => {
    const appointments = [
        appt("a2", "2027-01-20T19:00:00Z", ["ronnie", "xanthi"]),
        appt("a1", "2027-01-20T18:00:00Z", ["ronnie", "whitney"]),
        appt("a3", "2027-01-20T18:00:00Z", ["bob", "ted", "whitney"]),
        appt("a4", "2027-01-20T20:00:00Z", ["ronnie", "stranger"]),
        appt("a5", "2027-01-20T21:00:00Z", ["ronnie", "whitney"]),
    ];

    test("lists only that company's appointments the database doesn't have, by start time", () => {
        const rows = companyAppointmentsNotInPortal({
            appointments,
            attendees: ATTENDEES,
            accountId: "acct-lake",
            knownAppointmentIds: new Set(["a5"]),
        });
        expect(rows.map((r) => r.appointmentId)).toEqual(["a1", "a2", "a4"]);
        expect(rows[0]).toMatchObject({ startTime: "2027-01-20T18:00:00Z", locationName: "Booth 3" });
    });

    test("names the delegates, leaving out reps and people the portal doesn't know", () => {
        const rows = companyAppointmentsNotInPortal({
            appointments,
            attendees: ATTENDEES,
            accountId: "acct-lake",
            knownAppointmentIds: new Set(),
        });
        expect(rows.map((r) => r.delegates.map((d) => d.salesforceId))).toEqual([
            ["whitney"],
            ["xanthi"],
            [],
            ["whitney"],
        ]);
    });

    test("finds a company's appointment through any of its reps", () => {
        const rows = companyAppointmentsNotInPortal({
            appointments,
            attendees: ATTENDEES,
            accountId: "acct-21m",
            knownAppointmentIds: new Set(),
        });
        expect(rows.map((r) => r.appointmentId)).toEqual(["a3"]);
    });
});

describe("countAppointmentsNotInPortal", () => {
    test("counts each company's appointments the database doesn't have, once each", () => {
        const counts = countAppointmentsNotInPortal(
            [
                appt("a1", "2027-01-20T18:00:00Z", ["ronnie", "whitney"]),
                appt("a2", "2027-01-20T19:00:00Z", ["ronnie", "xanthi"]),
                appt("a3", "2027-01-20T18:00:00Z", ["bob", "ted", "whitney"]),
                appt("a4", "2027-01-20T20:00:00Z", ["whitney", "xanthi"]),
            ],
            ATTENDEES,
            new Set(["a2"]),
        );
        expect(Object.fromEntries(counts)).toEqual({ "acct-lake": 1, "acct-21m": 1 });
    });
});
