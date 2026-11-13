import { describe, expect, test } from "vitest";
import type { Attendee, Timeslot } from "@/types";
import type { CventExistingAppointment } from "@/lib/cvent/client";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import {
    busyStartTimes,
    cventOnlyForDelegates,
    dayOfStart,
    delegateMeetingCounts,
    keptD2DMeetings,
    slotRoomLeft,
    type MeetingRef,
} from "./delegateMeetings";

// ---------------------------------------------------------------------------
// Each delegate's meetings from the portal and from Cvent.
// ---------------------------------------------------------------------------

/**
 * Builds an attendee.
 *
 * @param {string} id - The Salesforce id, also used for the Cvent contact id.
 * @param {"delegate" | "sponsor"} role - The role.
 * @returns {Attendee} The attendee.
 */
function person(id: string, role: "delegate" | "sponsor"): Attendee {
    return {
        id,
        cventContactId: `c-${id}`,
        salesforceId: id,
        accountId: role === "sponsor" ? `acct-${id}` : "",
        name: id,
        email: "",
        phone: "",
        role,
        company: id,
        title: "",
        sponsorTier: role === "sponsor" ? "standard" : null,
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: 2, requestedSponsorAccountIds: [] },
    };
}

/**
 * Builds a Cvent appointment.
 *
 * @param {string} id - The appointment id.
 * @param {string} start - The ISO start time.
 * @param {string[]} contacts - The participants' contact ids.
 * @param {string | null} [locationName] - The location's name.
 * @returns {CventExistingAppointment} The appointment.
 */
function appt(id: string, start: string, contacts: string[], locationName: string | null = null): CventExistingAppointment {
    return { id, startTime: start, participantContactIds: contacts, hostContactIds: contacts.slice(0, 1), locationName };
}

/**
 * Builds a meeting row.
 *
 * @param {Partial<MeetingRef>} partial - The fields to set.
 * @returns {MeetingRef} The row.
 */
function row(partial: Partial<MeetingRef>): MeetingRef {
    return { kind: "sponsor_delegate", attendeeA: "", attendeeB: "", timeslotId: "t1", cventAppointmentId: null, ...partial };
}

const PEOPLE = [person("d1", "delegate"), person("d2", "delegate"), person("d3", "delegate"), person("s1", "sponsor")];
const SLOTS: Timeslot[] = [
    { id: "t1", day: 1, startTime: "2027-01-20T10:00:00.000Z", endTime: "2027-01-20T10:20:00.000Z", capacity: 3, locationId: "loc-a", appointmentTypeId: "x", appointmentTypeName: null, kind: "delegate_delegate" },
    { id: "t2", day: 2, startTime: "2027-01-21T10:00:00.000Z", endTime: "2027-01-21T10:20:00.000Z", capacity: 3, locationId: "loc-a", appointmentTypeId: "x", appointmentTypeName: null, kind: "delegate_delegate" },
];

describe("cventOnlyForDelegates and delegateMeetingCounts", () => {
    test("counts portal and Cvent-only meetings, S2D when a sponsor is in it and D2D otherwise", () => {
        const appointments = [
            appt("pushed", "2027-01-20T09:00:00Z", ["c-s1", "c-d1"]),
            appt("cvent-s2d", "2027-01-20T09:30:00Z", ["c-s1", "c-d2"]),
            appt("cvent-d2d", "2027-01-20T11:00:00Z", ["c-d1", "c-d2"]),
            appt("strangers", "2027-01-20T11:00:00Z", ["c-x"]),
        ];
        const rows = [
            row({ attendeeA: "acct-s1", attendeeB: "d1", cventAppointmentId: "pushed" }),
            row({ kind: "delegate_delegate", attendeeA: "d1", attendeeB: "d3" }),
        ];
        const cventOnly = cventOnlyForDelegates(appointments, PEOPLE, new Set(["pushed"]));
        expect(cventOnly.map((c) => c.appointment.id)).toEqual(["cvent-s2d", "cvent-d2d"]);

        const counts = delegateMeetingCounts(rows, cventOnly);
        expect(counts.get("d1")).toEqual({ s2d: 1, d2d: 2 });
        expect(counts.get("d2")).toEqual({ s2d: 1, d2d: 1 });
        expect(counts.get("d3")).toEqual({ s2d: 0, d2d: 1 });
    });

    test("leaves out appointments the portal pushed, roundtables included", () => {
        const cventOnly = cventOnlyForDelegates(
            [appt("rt", "2027-01-20T15:00:00Z", ["c-d1", "c-d2", "c-d3"])],
            PEOPLE,
            new Set(["rt"]),
        );
        expect(cventOnly).toEqual([]);
    });
});

describe("busyStartTimes", () => {
    test("criterion 9: marks both sides of portal meetings and every delegate in a Cvent appointment as busy", () => {
        const busy = busyStartTimes(
            [row({ attendeeA: "acct-s1", attendeeB: "d1", timeslotId: "t1" })],
            new Map(SLOTS.map((s) => [s.id, s])),
            [appt("a", "2027-01-21T10:00:00Z", ["c-d2", "c-s1"])],
            PEOPLE,
        );
        expect([...busy.get("d1")!]).toEqual([Date.parse(SLOTS[0].startTime)]);
        expect([...busy.get("d2")!]).toEqual([Date.parse(SLOTS[1].startTime)]);
        expect(busy.has("s1")).toBe(false);
    });
});

describe("keptD2DMeetings and dayOfStart", () => {
    test("keeps pushed rows and adds delegate-only Cvent appointments with their day", () => {
        const cventOnly = cventOnlyForDelegates(
            [appt("solo", "2027-01-21T12:00:00Z", ["c-d3"]), appt("pair", "2027-01-20T12:00:00Z", ["c-d1", "c-d2"])],
            PEOPLE,
            new Set(),
        );
        const kept = keptD2DMeetings(
            [{ ...row({ kind: "delegate_delegate", attendeeA: "d1", attendeeB: "d2" }), day: 1 }],
            cventOnly,
            SLOTS,
        );
        expect(kept).toEqual([
            { attendeeA: "d1", attendeeB: "d2", day: 1 },
            { attendeeA: "d3", attendeeB: "cvent:solo", day: 2 },
            { attendeeA: "d1", attendeeB: "d2", day: 1 },
        ]);
        expect(dayOfStart("2027-01-25T10:00:00Z", SLOTS)).toBe(2);
    });
});

describe("slotRoomLeft", () => {
    test("takes Cvent appointments at the slot's location and time off its capacity", () => {
        const room = slotRoomLeft(
            SLOTS,
            [{ id: "loc-a", name: "D2D Lounge", capacity: 3, parentLocationId: null }],
            [appt("a", "2027-01-20T10:00:00Z", ["c-d1"], "d2d lounge "), appt("b", "2027-01-20T10:00:00Z", ["c-d2"], "Elsewhere")],
            [],
        );
        expect(room.get("t1")).toBe(2);
        expect(room.get("t2")).toBe(3);
    });

    test("takes kept portal meetings off instead when Cvent couldn't be read", () => {
        const room = slotRoomLeft(SLOTS, [], null, [row({ timeslotId: "t2" })]);
        expect(room.get("t1")).toBe(3);
        expect(room.get("t2")).toBe(2);
    });
});
