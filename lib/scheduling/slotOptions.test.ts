import { describe, test, expect } from "vitest";
import type { Location, Timeslot } from "@/types";
import type { MeetingKind } from "@/lib/events/meetingKinds";
import {
    bookedIntervals,
    buildSlotOptions,
    groupSlotOptions,
    isOtherCompanysBooth,
    slotLocationWarning,
    slotTypeWarning,
    sortSlotOptions,
    sponsorBoothFilter,
    type SlotOption,
} from "./slotOptions";
import type { CompanyBooth } from "./booths";

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

describe("buildSlotOptions — sponsor booths", () => {
    const BOOTHS = new Map<string, Location>([
        ["b2", { id: "b2", name: "Booth 2", capacity: Infinity, parentLocationId: null }],
        ["b3", { id: "b3", name: "Booth 3", capacity: Infinity, parentLocationId: null }],
        ["b4", { id: "b4", name: "Booth 4", capacity: Infinity, parentLocationId: null }],
        ["tbl", { id: "tbl", name: "Table 1A", capacity: 2, parentLocationId: null }],
    ]);

    /**
     * Builds a sponsor slot at a location.
     *
     * @param {string} id - The slot id.
     * @param {string} startTime - ISO start time.
     * @param {string} locationId - The location.
     * @returns {Timeslot} The slot.
     */
    function at(id: string, startTime: string, locationId: string): Timeslot {
        return { ...slot(id, 1, startTime, "s2d"), locationId };
    }

    const SLOTS = [
        at("b2-09", "2026-01-20T09:00:00.000Z", "b2"),
        at("tbl-09", "2026-01-20T09:00:00.000Z", "tbl"),
        at("b4-09", "2026-01-20T09:00:00.000Z", "b4"),
        at("b3-11", "2026-01-20T11:00:00.000Z", "b3"),
        at("b3-10", "2026-01-20T10:00:00.000Z", "b3"),
    ];

    /**
     * Builds the booths of three companies: Lakeside at Booth 3, and two others at Booths 2 and 4.
     *
     * @returns {Map<string, CompanyBooth>} The booths.
     */
    function booths(): Map<string, CompanyBooth> {
        /**
         * One company's booth.
         *
         * @param {string} accountId - The company.
         * @param {string} locationId - Its booth location.
         * @returns {CompanyBooth} The booth.
         */
        const b = (accountId: string, locationId: string): CompanyBooth => ({
            accountId,
            boothNo: locationId,
            location: BOOTHS.get(locationId)!,
            source: "automatic",
            manualLocationId: null,
            automaticLocation: BOOTHS.get(locationId)!,
            problems: [],
        });
        return new Map([
            ["acct-lakeside", b("acct-lakeside", "b3")],
            ["acct-montopolis", b("acct-montopolis", "b2")],
            ["acct-match", b("acct-match", "b4")],
        ]);
    }

    test("puts the sponsor's own booth slots first and never offers another company's booth", () => {
        const filter = sponsorBoothFilter("acct-lakeside", booths());
        const options = buildSlotOptions(SLOTS, BOOTHS, [], [], filter);

        expect(options.map((o) => o.timeslotId)).toEqual(["b3-10", "b3-11", "tbl-09"]);
        expect(options.map((o) => o.ownBooth)).toEqual([true, true, false]);
    });

    test("groups the own booth slots under a label naming the booth", () => {
        const filter = sponsorBoothFilter("acct-lakeside", booths());
        const groups = groupSlotOptions(buildSlotOptions(SLOTS, BOOTHS, [], [], filter));

        expect(groups.map((g) => [g.label, g.options.length])).toEqual([
            ["Sponsor to Delegate Meetings at Booth 3 (this sponsor's booth)", 2],
            ["Sponsor to Delegate Meetings", 1],
        ]);
    });

    test("warns, naming the location, for a slot that isn't at the sponsor's booth", () => {
        const filter = sponsorBoothFilter("acct-lakeside", booths());
        const byId = new Map(buildSlotOptions(SLOTS, BOOTHS, [], [], filter).map((o) => [o.timeslotId, o]));

        expect(slotLocationWarning(byId.get("tbl-09"))).toBe(
            "This slot is at Table 1A, not at this sponsor's booth.",
        );
        expect(slotLocationWarning(byId.get("b3-10"))).toBeNull();
    });

    test("a sponsor with no booth is offered every slot except other companies' booths, each with a warning", () => {
        const filter = sponsorBoothFilter("acct-no-booth", booths());
        const options = buildSlotOptions(SLOTS, BOOTHS, [], [], filter);

        expect(options.map((o) => o.timeslotId)).toEqual(["tbl-09"]);
        expect(slotLocationWarning(options[0])).not.toBeNull();
    });

    test("with no booth filter every slot is offered, as before", () => {
        expect(buildSlotOptions(SLOTS, BOOTHS, [], [])).toHaveLength(5);
        expect(isOtherCompanysBooth({ locationId: "b2" }, undefined)).toBe(false);
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
