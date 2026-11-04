import { describe, test, expect } from "vitest";
import type { Attendee, Location, Timeslot } from "@/types";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { buildBoothRows } from "./boothRows";

// ---------------------------------------------------------------------------
// The Sponsor booths page rows: one per company, with its values and warnings.
// Modeled on the three NALES test sponsors in the spec's manual check.
// ---------------------------------------------------------------------------

/**
 * Builds a sponsor rep.
 *
 * @param {string} id - The rep's Salesforce id.
 * @param {string} accountId - The company's Account id.
 * @param {string} company - The company name.
 * @param {Partial<Attendee>} [partial] - Fields to set.
 * @returns {Attendee} The rep.
 */
function rep(id: string, accountId: string, company: string, partial: Partial<Attendee> = {}): Attendee {
    return {
        id,
        cventContactId: partial.cventContactId ?? `cvent-${id}`,
        cventCancelled: partial.cventCancelled,
        salesforceId: id,
        accountId,
        name: partial.name ?? id,
        email: "",
        phone: "",
        role: "sponsor",
        company,
        title: "",
        sponsorTier: partial.sponsorTier ?? "standard",
        opportunityId: partial.opportunityId ?? `opp-${accountId}`,
        boothNo: partial.boothNo === undefined ? null : partial.boothNo,
        purchasedMeetings: partial.purchasedMeetings ?? null,
        bonusMeetings: partial.bonusMeetings ?? null,
        maximumMeetings: partial.maximumMeetings ?? null,
        meetingsAtOnce: partial.meetingsAtOnce ?? null,
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: null, requestedSponsorAccountIds: [] },
    };
}

/**
 * Builds a Cvent location.
 *
 * @param {string} id - The location id.
 * @param {string} name - The location name.
 * @returns {Location} The location.
 */
function loc(id: string, name: string): Location {
    return { id, name, capacity: Infinity, parentLocationId: null };
}

/**
 * Builds a sponsor slot at a booth.
 *
 * @param {string} locationId - The booth.
 * @param {number} capacity - Cvent's per-slot limit.
 * @returns {Timeslot} The slot.
 */
function slot(locationId: string, capacity: number): Timeslot {
    return {
        id: `ts-${locationId}`,
        day: 1,
        startTime: "2026-11-10T09:00:00.000Z",
        endTime: "2026-11-10T09:20:00.000Z",
        capacity,
        locationId,
        appointmentTypeId: "t-s2d",
        appointmentTypeName: "Sponsor to Delegate Meetings",
        kind: "sponsor_delegate",
    };
}

const LOCATIONS = [loc("b2", "Booth 2"), loc("b3", "Booth 3"), loc("b4", "Booth 4"), loc("b5", "Booth 5")];
const TIMESLOTS = [slot("b2", 1), slot("b3", 1), slot("b4", 1), slot("b5", 2)];

const ATTENDEES = [
    rep("a1", "acct-21m", "21 Montopolis [TEST]", { name: "Bob Johnson", boothNo: "2", maximumMeetings: 5, meetingsAtOnce: 2 }),
    rep("a2", "acct-21m", "21 Montopolis [TEST]", { name: "Ted Stefandis", boothNo: "2", maximumMeetings: 5, meetingsAtOnce: 2 }),
    rep("a3", "acct-lake", "Lakeside Learning Co. [TEST]", { name: "Ronnie Tester", boothNo: "3", purchasedMeetings: 4, bonusMeetings: 1, maximumMeetings: 6 }),
    rep("a4", "acct-match", "Match Made in Heaven [TEST]", { name: "Carolina figueroa", boothNo: "4" }),
    rep("a5", "acct-match", "Match Made in Heaven [TEST]", { name: "Alejandro Gil", boothNo: "4", cventContactId: "" }),
    rep("a6", "acct-real", "Real Sponsor", { purchasedMeetings: 3 }),
];

describe("buildBoothRows", () => {
    const rows = buildBoothRows(ATTENDEES, LOCATIONS, TIMESLOTS, { "3": "b5" });
    const byCompany = new Map(rows.map((r) => [r.company, r]));

    test("lists every sponsor company once, sorted by name, with its reps", () => {
        expect(rows.map((r) => r.company)).toEqual([
            "21 Montopolis [TEST]",
            "Lakeside Learning Co. [TEST]",
            "Match Made in Heaven [TEST]",
            "Real Sponsor",
        ]);
        expect(byCompany.get("Match Made in Heaven [TEST]")!.reps.map((r) => r.name)).toEqual([
            "Carolina figueroa",
            "Alejandro Gil",
        ]);
    });

    test("says how many reps can host in Cvent", () => {
        const match = byCompany.get("Match Made in Heaven [TEST]")!;
        expect(match.hostCount).toBe(1);
        expect(match.reps.map((r) => r.canHost)).toEqual([true, false]);
    });

    test("shows the Booth No., the location, where it came from and the booth's per-slot limit", () => {
        expect(byCompany.get("21 Montopolis [TEST]")).toMatchObject({
            boothNo: "2",
            location: { id: "b2", name: "Booth 2" },
            matchSource: "automatic",
            perSlotLimit: 1,
        });
        expect(byCompany.get("Lakeside Learning Co. [TEST]")).toMatchObject({
            boothNo: "3",
            location: { id: "b5", name: "Booth 5" },
            matchSource: "manual",
            automaticLocation: { id: "b3", name: "Booth 3" },
            perSlotLimit: 2,
        });
    });

    test("shows purchased, bonus, maximum and meetings at once", () => {
        expect(byCompany.get("Lakeside Learning Co. [TEST]")).toMatchObject({
            purchased: 4,
            bonus: 1,
            maximumField: 6,
            maximum: 6,
            maximumSource: "maximum",
            meetingsAtOnce: null,
        });
        expect(byCompany.get("21 Montopolis [TEST]")!.meetingsAtOnce).toBe(2);
    });

    test('marks a maximum that comes from the tier, for the "from tier" note', () => {
        expect(byCompany.get("Match Made in Heaven [TEST]")).toMatchObject({
            maximum: 5,
            maximumSource: "tier",
        });
    });

    test("shows a booth problem", () => {
        expect(byCompany.get("Real Sponsor")!.problems).toEqual(["no_booth"]);
        expect(byCompany.get("21 Montopolis [TEST]")!.problems).toEqual([]);
    });

    test("warns when meetings at once is more than the booth's Cvent limit", () => {
        expect(byCompany.get("21 Montopolis [TEST]")!.warnings).toEqual([
            "Meetings at once is 2, but Booth 2 takes only 1 per slot in Cvent.",
        ]);
    });

    test("warns when meetings at once is more than the reps who can host", () => {
        const rows2 = buildBoothRows(
            [rep("x1", "acct-x", "X", { boothNo: "5", meetingsAtOnce: 2 })],
            LOCATIONS,
            TIMESLOTS,
            null,
        );
        expect(rows2[0].warnings).toEqual(["Meetings at once is 2, but only 1 rep can host in Cvent."]);
    });

    test("warns when Cvent_Maximum_Meetings__c differs from purchased plus bonus", () => {
        expect(byCompany.get("Lakeside Learning Co. [TEST]")!.warnings).toEqual([
            "Cvent maximum is 6, but purchased plus bonus is 5.",
        ]);
    });
});
