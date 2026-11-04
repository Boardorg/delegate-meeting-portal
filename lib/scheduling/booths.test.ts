import { describe, test, expect } from "vitest";
import type { Attendee, Location, Timeslot } from "@/types";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { sponsorCompaniesByAccountId } from "@/lib/attendees/companies";
import {
    autoMatchBoothLocation,
    boothPerSlotLimit,
    countBoothProblems,
    primaryBoothProblem,
    resolveBoothLocation,
    resolveCompanyBooths,
    sponsorSlotLocations,
    validateBoothMapping,
    withBoothMapping,
} from "./booths";

// ---------------------------------------------------------------------------
// Matching booth numbers to Cvent locations, and the problems that stop a
// company's meetings.
// ---------------------------------------------------------------------------

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

const BOOTH_3 = loc("loc-3", "Booth 3");
const BOOTH_13 = loc("loc-13", "Booth 13");
const BOOTH_5 = loc("loc-5", "Booth 5");
const LOCATIONS = [BOOTH_13, BOOTH_3, BOOTH_5, loc("loc-t", "Table 1A")];

/**
 * Builds a one-rep sponsor company's rep.
 *
 * @param {string} accountId - The company's Account id.
 * @param {Partial<Attendee>} [partial] - Fields to set.
 * @returns {Attendee} The rep.
 */
function rep(accountId: string, partial: Partial<Attendee> = {}): Attendee {
    const id = partial.salesforceId ?? `rep-${accountId}`;
    return {
        id,
        cventContactId: `cvent-${id}`,
        salesforceId: id,
        accountId,
        name: id,
        email: "",
        phone: "",
        role: "sponsor",
        company: accountId,
        title: "",
        sponsorTier: "standard",
        opportunityId: partial.opportunityId ?? `opp-${accountId}`,
        boothNo: partial.boothNo === undefined ? "3" : partial.boothNo,
        purchasedMeetings: partial.purchasedMeetings ?? null,
        bonusMeetings: null,
        maximumMeetings: partial.maximumMeetings ?? null,
        meetingsAtOnce: null,
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: null, requestedSponsorAccountIds: [] },
    };
}

/**
 * Resolves the booths for a set of reps.
 *
 * @param {Attendee[]} reps - The reps.
 * @param {Record<string, string> | null} [mappings] - The manual mapping.
 * @returns The booths, keyed by Account id.
 */
function boothsFor(reps: Attendee[], mappings: Record<string, string> | null = null) {
    return resolveCompanyBooths(
        [...sponsorCompaniesByAccountId(reps).values()],
        LOCATIONS,
        mappings,
    );
}

describe("autoMatchBoothLocation", () => {
    test('"3" and "Booth 3" both match the Cvent location "Booth 3"', () => {
        expect(autoMatchBoothLocation("3", LOCATIONS)).toEqual(BOOTH_3);
        expect(autoMatchBoothLocation("Booth 3", LOCATIONS)).toEqual(BOOTH_3);
    });

    test('"3" does not match "Booth 13"', () => {
        expect(autoMatchBoothLocation("3", [BOOTH_13])).toBeNull();
    });

    test("ignores case and spaces at the ends", () => {
        expect(autoMatchBoothLocation("  booth 3 ", LOCATIONS)).toEqual(BOOTH_3);
        expect(autoMatchBoothLocation(" 3", [loc("x", " BOOTH 3 ")])?.id).toBe("x");
    });

    test("a blank booth number matches nothing", () => {
        expect(autoMatchBoothLocation("  ", LOCATIONS)).toBeNull();
        expect(autoMatchBoothLocation(null, LOCATIONS)).toBeNull();
    });
});

describe("resolveBoothLocation", () => {
    test('a manual mapping for "3" wins over the automatic match', () => {
        const r = resolveBoothLocation("3", LOCATIONS, { "3": BOOTH_5.id });
        expect(r).toMatchObject({ location: BOOTH_5, source: "manual", automaticLocation: BOOTH_3 });
    });

    test("removing the mapping brings the automatic match back", () => {
        const mapped = withBoothMapping(null, "3", BOOTH_5.id);
        const removed = withBoothMapping(mapped, "3", null);

        expect(removed).toBeNull();
        expect(resolveBoothLocation("3", LOCATIONS, removed)).toMatchObject({
            location: BOOTH_3,
            source: "automatic",
            manualLocationId: null,
        });
    });

    test("a booth number with spaces uses the mapping stored under the trimmed number", () => {
        expect(resolveBoothLocation(" 3 ", LOCATIONS, { "3": BOOTH_5.id }).location).toEqual(BOOTH_5);
    });

    test("a manual mapping to a location Cvent no longer returns gives no location, not the automatic match", () => {
        const r = resolveBoothLocation("3", LOCATIONS, { "3": "loc-gone" });
        expect(r).toMatchObject({ location: null, source: null, manualLocationId: "loc-gone" });
    });
});

describe("resolveCompanyBooths", () => {
    test("a blank booth gives no_booth", () => {
        const booths = boothsFor([rep("a", { boothNo: null })]);
        expect(booths.get("a")!.problems).toEqual(["no_booth"]);
    });

    test("a booth that matches no Cvent location gives booth_not_found", () => {
        const booths = boothsFor([rep("a", { boothNo: "99" })]);
        expect(primaryBoothProblem(booths.get("a"))).toBe("booth_not_found");
    });

    test("a manual mapping to a location Cvent no longer returns gives booth_not_found", () => {
        const booths = boothsFor([rep("a", { boothNo: "3" })], { "3": "loc-gone" });
        expect(booths.get("a")!.problems).toEqual(["booth_not_found"]);
    });

    test("two companies claiming the same booth both get booth_conflict", () => {
        const booths = boothsFor([rep("a", { boothNo: "3" }), rep("b", { boothNo: "Booth 3" })]);
        expect(booths.get("a")!.problems).toEqual(["booth_conflict"]);
        expect(booths.get("b")!.problems).toEqual(["booth_conflict"]);
    });

    test("two booth numbers mapped to the same location give booth_conflict for both companies", () => {
        const booths = boothsFor(
            [rep("a", { boothNo: "3" }), rep("b", { boothNo: "5" })],
            { "3": BOOTH_5.id },
        );
        expect(booths.get("a")!.problems).toEqual(["booth_conflict"]);
        expect(booths.get("b")!.problems).toEqual(["booth_conflict"]);
    });

    test("reps on more than one Opportunity give multiple_opportunities", () => {
        const booths = boothsFor([
            rep("a", { salesforceId: "r1", opportunityId: "opp-1" }),
            rep("a", { salesforceId: "r2", opportunityId: "opp-2" }),
        ]);
        expect(booths.get("a")!.problems).toEqual(["multiple_opportunities"]);
    });

    test("a maximum of 0 gives no_package_meetings", () => {
        const booths = boothsFor([rep("a", { purchasedMeetings: 0 })]);
        expect(booths.get("a")!.problems).toEqual(["no_package_meetings"]);
    });

    test("a company with its own matched booth has no problems", () => {
        const booths = boothsFor([rep("a", { boothNo: "3" }), rep("b", { boothNo: "5" })]);
        expect(booths.get("a")).toMatchObject({ location: BOOTH_3, source: "automatic", problems: [] });
        expect(countBoothProblems(booths)).toBe(0);
    });

    test("counts the companies with a problem", () => {
        const booths = boothsFor([rep("a", { boothNo: null }), rep("b", { boothNo: "99" }), rep("c", { boothNo: "5" })]);
        expect(countBoothProblems(booths)).toBe(2);
    });
});

describe("validateBoothMapping", () => {
    test("rejects a location id the event doesn't have", () => {
        const r = validateBoothMapping("3", "loc-other-event", LOCATIONS);
        expect(r.ok).toBe(false);
    });

    test("accepts one of the event's locations and trims the booth number", () => {
        expect(validateBoothMapping(" 3 ", BOOTH_5.id, LOCATIONS)).toEqual({ ok: true, boothNo: "3" });
    });

    test("always accepts removing a mapping, and rejects a blank booth number", () => {
        expect(validateBoothMapping("3", null, []).ok).toBe(true);
        expect(validateBoothMapping("  ", null, LOCATIONS).ok).toBe(false);
    });
});

describe("sponsorSlotLocations and boothPerSlotLimit", () => {
    /**
     * Builds a timeslot at a location.
     *
     * @param {string} locationId - The location id.
     * @param {number} capacity - The slot's capacity.
     * @param {Timeslot["kind"]} kind - The slot's meeting kind.
     * @returns {Timeslot} The timeslot.
     */
    function slot(locationId: string, capacity: number, kind: Timeslot["kind"]): Timeslot {
        return {
            id: `${locationId}-${capacity}-${kind}`,
            day: 1,
            startTime: "2026-01-20T09:00:00.000Z",
            endTime: "2026-01-20T09:20:00.000Z",
            capacity,
            locationId,
            appointmentTypeId: "t",
            appointmentTypeName: null,
            kind,
        };
    }

    test("offers only locations with sponsor_delegate slots", () => {
        const timeslots = [slot("loc-3", 2, "sponsor_delegate"), slot("loc-t", 5, "delegate_group")];
        expect(sponsorSlotLocations(LOCATIONS, timeslots).map((l) => l.id)).toEqual(["loc-3"]);
    });

    test("reads the booth's per-slot limit from its sponsor slots", () => {
        const timeslots = [slot("loc-3", 1, "sponsor_delegate"), slot("loc-3", 2, "sponsor_delegate")];
        expect(boothPerSlotLimit("loc-3", timeslots)).toBe(2);
        expect(boothPerSlotLimit("loc-5", timeslots)).toBeNull();
    });
});
