import { describe, test, expect } from "vitest";
import type { Location, Timeslot } from "@/types";
import type { MeetingKind } from "@/lib/events/meetingKinds";
import {
    bookedIntervals,
    buildSlotOptions,
    groupSlotOptions,
    slotTypeWarning,
    sortSlotOptions,
    type SlotOption,
} from "./slotOptions";

// Appointment types as NALES names them, with the kind the event maps each to.
const TYPE: Record<string, { name: string; kind: MeetingKind }> = {
    s2d: { name: "Sponsor to Delegate Meetings", kind: "sponsor_delegate" },
    group: { name: "Delegate Group Meetings", kind: "ignore" },
    d2d: { name: "Delegate to Delegate Meetings", kind: "delegate_delegate" },
};

/**
 * Builds a timeslot of one of the TYPE appointment types.
 *
 * @param {string} id - The timeslot id.
 * @param {1 | 2} day - The event day.
 * @param {string} startTime - ISO start time.
 * @param {keyof typeof TYPE} type - Which appointment type.
 * @returns {Timeslot} The timeslot.
 */
function slot(id: string, day: 1 | 2, startTime: string, type: keyof typeof TYPE): Timeslot {
    const end = new Date(new Date(startTime).getTime() + 20 * 60_000).toISOString();
    return {
        id,
        day,
        startTime,
        endTime: end,
        capacity: 2,
        locationId: "loc-1",
        appointmentTypeId: `t-${type}`,
        appointmentTypeName: TYPE[type].name,
        kind: TYPE[type].kind,
    };
}

const LOCATIONS = new Map<string, Location>([
    ["loc-1", { id: "loc-1", name: "Table 1A", capacity: 2, parentLocationId: null }],
]);

// Listed in Cvent order, with the Delegate Group slot earliest on Day 1.
const TIMESLOTS = [
    slot("group-1", 1, "2026-01-20T09:00:00.000Z", "group"),
    slot("d2d-1", 1, "2026-01-20T09:30:00.000Z", "d2d"),
    slot("s2d-2", 2, "2026-01-21T10:00:00.000Z", "s2d"),
    slot("s2d-1", 1, "2026-01-20T10:00:00.000Z", "s2d"),
    slot("group-2", 2, "2026-01-21T09:00:00.000Z", "group"),
];

describe("buildSlotOptions", () => {
    test("lists every slot from both days, grouped by type with sponsor_delegate first", () => {
        const options = buildSlotOptions(TIMESLOTS, LOCATIONS, [], []);

        expect(options.map((o) => o.timeslotId)).toEqual([
            // Sponsor slots first, by day then time.
            "s2d-1",
            "s2d-2",
            // Then the other types by name.
            "group-1",
            "group-2",
            "d2d-1",
        ]);
    });

    test("says which appointment type each option is, and its kind", () => {
        const options = buildSlotOptions(TIMESLOTS, LOCATIONS, [], []);

        const byId = new Map(options.map((o) => [o.timeslotId, o]));
        expect(byId.get("s2d-1")).toMatchObject({
            appointmentTypeName: "Sponsor to Delegate Meetings",
            kind: "sponsor_delegate",
            locationName: "Table 1A",
        });
        expect(byId.get("group-2")).toMatchObject({
            appointmentTypeName: "Delegate Group Meetings",
            kind: "ignore",
        });
    });

    test("still leaves out slots that double-book either attendee", () => {
        const booked = bookedIntervals(
            [{ attendeeA: "acct-1", attendeeB: "d9", timeslotId: "s2d-1" }],
            "acct-1",
            new Map(TIMESLOTS.map((t) => [t.id, t])),
        );

        const options = buildSlotOptions(TIMESLOTS, LOCATIONS, booked, []);

        expect(options.map((o) => o.timeslotId)).not.toContain("s2d-1");
        expect(options).toHaveLength(4);
    });
});

describe("groupSlotOptions", () => {
    test("makes one group per appointment type, sponsor type first", () => {
        const groups = groupSlotOptions(buildSlotOptions(TIMESLOTS, LOCATIONS, [], []));

        expect(groups.map((g) => [g.label, g.options.length])).toEqual([
            ["Sponsor to Delegate Meetings", 2],
            ["Delegate Group Meetings", 2],
            ["Delegate to Delegate Meetings", 1],
        ]);
    });

    test("puts a current slot Cvent no longer lists in its own group at the end", () => {
        const unknown: SlotOption = {
            timeslotId: "gone",
            day: 1,
            startTime: "",
            endTime: "",
            locationId: null,
            locationName: null,
            appointmentTypeId: null,
            appointmentTypeName: null,
            kind: null,
        };
        const options = sortSlotOptions([
            unknown,
            ...buildSlotOptions(TIMESLOTS, LOCATIONS, [], []),
        ]);

        const groups = groupSlotOptions(options);
        expect(groups[0].label).toBe("Sponsor to Delegate Meetings");
        expect(groups[groups.length - 1]).toMatchObject({
            label: "Unknown appointment type",
            options: [unknown],
        });
    });
});

describe("slotTypeWarning", () => {
    const options = buildSlotOptions(TIMESLOTS, LOCATIONS, [], []);
    const byId = new Map(options.map((o) => [o.timeslotId, o]));

    test("warns, naming the type, when the chosen slot isn't sponsor_delegate", () => {
        expect(slotTypeWarning(byId.get("group-1"))).toBe(
            'This meeting will appear in Cvent as a "Delegate Group Meetings" appointment, not a sponsor to delegate meeting.',
        );
        expect(slotTypeWarning(byId.get("d2d-1"))).toContain(
            "Delegate to Delegate Meetings",
        );
    });

    test("shows no warning for a sponsor_delegate slot on either day", () => {
        expect(slotTypeWarning(byId.get("s2d-1"))).toBeNull();
        expect(slotTypeWarning(byId.get("s2d-2"))).toBeNull();
    });

    test("shows no warning before a slot is chosen", () => {
        expect(slotTypeWarning(undefined)).toBeNull();
    });
});
