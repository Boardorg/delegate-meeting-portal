import { describe, test, expect } from "vitest";
import type { Attendee } from "@/types";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { sponsorCompaniesByAccountId } from "./companies";
import {
    companyMaximumMeetings,
    companyMeetingsAtOnce,
    maximumDiffersFromPackage,
} from "./caps";

// ---------------------------------------------------------------------------
// Meeting maximums and meetings at once, from the Salesforce count fields.
// ---------------------------------------------------------------------------

/**
 * Builds a sponsor rep of the company "acct-1".
 *
 * @param {Partial<Attendee>} [partial] - Fields to set.
 * @returns {Attendee} The rep.
 */
function rep(partial: Partial<Attendee> = {}): Attendee {
    const id = partial.salesforceId ?? "s1";
    return {
        id,
        cventContactId: partial.cventContactId ?? `cvent-${id}`,
        cventCancelled: partial.cventCancelled,
        salesforceId: id,
        accountId: partial.accountId ?? "acct-1",
        name: id,
        email: "",
        phone: "",
        role: "sponsor",
        company: "Acme",
        title: "",
        sponsorTier: partial.sponsorTier ?? "standard",
        opportunityId: partial.opportunityId ?? "opp-1",
        boothNo: partial.boothNo ?? "1",
        purchasedMeetings: partial.purchasedMeetings ?? null,
        bonusMeetings: partial.bonusMeetings ?? null,
        maximumMeetings: partial.maximumMeetings ?? null,
        meetingsAtOnce: partial.meetingsAtOnce ?? null,
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: null, requestedSponsorAccountIds: [] },
    };
}

/**
 * Groups reps into their one company.
 *
 * @param {Attendee[]} reps - Reps of "acct-1".
 * @returns The company.
 */
function companyOf(reps: Attendee[]) {
    return sponsorCompaniesByAccountId(reps).get("acct-1")!;
}

describe("companyMaximumMeetings", () => {
    test("uses Cvent_Maximum_Meetings__c when it is set", () => {
        const c = companyOf([rep({ maximumMeetings: 6, purchasedMeetings: 3, bonusMeetings: 1 })]);
        expect(companyMaximumMeetings(c)).toEqual({ maximum: 6, source: "maximum" });
    });

    test("otherwise uses purchased plus bonus", () => {
        const c = companyOf([rep({ purchasedMeetings: 3, bonusMeetings: 2 })]);
        expect(companyMaximumMeetings(c)).toEqual({ maximum: 5, source: "purchased_plus_bonus" });
    });

    test("counts a blank bonus as 0 when purchased is set", () => {
        const c = companyOf([rep({ purchasedMeetings: 4 })]);
        expect(companyMaximumMeetings(c).maximum).toBe(4);
    });

    test("counts a blank purchased as 0 when bonus is set", () => {
        const c = companyOf([rep({ bonusMeetings: 2 })]);
        expect(companyMaximumMeetings(c)).toEqual({ maximum: 2, source: "purchased_plus_bonus" });
    });

    test("falls back to 8 for a diamond company when all three are blank", () => {
        const c = companyOf([rep({ sponsorTier: "diamond" })]);
        expect(companyMaximumMeetings(c)).toEqual({ maximum: 8, source: "tier" });
    });

    test("falls back to 5 for any other company when all three are blank", () => {
        expect(companyMaximumMeetings(companyOf([rep()]))).toEqual({ maximum: 5, source: "tier" });
        expect(companyMaximumMeetings({ tier: null, purchasedMeetings: null, bonusMeetings: null, maximumMeetings: null }).maximum).toBe(5);
    });

    test("a 0 in Meetings__c gives 0, not the tier count", () => {
        const c = companyOf([rep({ purchasedMeetings: 0, sponsorTier: "diamond" })]);
        expect(companyMaximumMeetings(c)).toEqual({ maximum: 0, source: "purchased_plus_bonus" });
    });

    test("a 0 in Cvent_Maximum_Meetings__c gives 0 even when purchased is set", () => {
        const c = companyOf([rep({ maximumMeetings: 0, purchasedMeetings: 5 })]);
        expect(companyMaximumMeetings(c).maximum).toBe(0);
    });
});

describe("maximumDiffersFromPackage", () => {
    test("is true when the maximum differs from purchased plus bonus", () => {
        expect(maximumDiffersFromPackage({ maximumMeetings: 6, purchasedMeetings: 5, bonusMeetings: 0 })).toBe(true);
    });

    test("is false when they agree, or when there is nothing to compare", () => {
        expect(maximumDiffersFromPackage({ maximumMeetings: 5, purchasedMeetings: 4, bonusMeetings: 1 })).toBe(false);
        expect(maximumDiffersFromPackage({ maximumMeetings: 5, purchasedMeetings: null, bonusMeetings: null })).toBe(false);
        expect(maximumDiffersFromPackage({ maximumMeetings: null, purchasedMeetings: 4, bonusMeetings: 1 })).toBe(false);
    });
});

describe("companyMeetingsAtOnce", () => {
    test("allows Diaries meetings at once when that many reps can host", () => {
        const c = companyOf([
            rep({ salesforceId: "s1", meetingsAtOnce: 2 }),
            rep({ salesforceId: "s2", meetingsAtOnce: 2 }),
        ]);
        expect(companyMeetingsAtOnce(c)).toBe(2);
    });

    test("is held to the reps who can host", () => {
        // Diaries 2, but the second rep isn't linked in Cvent and the third cancelled.
        const c = companyOf([
            rep({ salesforceId: "s1", meetingsAtOnce: 2 }),
            rep({ salesforceId: "s2", meetingsAtOnce: 2, cventContactId: "" }),
            rep({ salesforceId: "s3", meetingsAtOnce: 2, cventCancelled: true }),
        ]);
        expect(companyMeetingsAtOnce(c)).toBe(1);
    });

    test("a blank Diaries field allows one at a time", () => {
        const c = companyOf([rep({ salesforceId: "s1" }), rep({ salesforceId: "s2" })]);
        expect(companyMeetingsAtOnce(c)).toBe(1);
    });

    test("never goes below 1, even with no rep who can host", () => {
        const c = companyOf([rep({ cventContactId: "", meetingsAtOnce: 2 })]);
        expect(companyMeetingsAtOnce(c)).toBe(1);
    });

    test("a Diaries value of 0 counts as 1", () => {
        const c = companyOf([rep({ salesforceId: "s1", meetingsAtOnce: 0 }), rep({ salesforceId: "s2", meetingsAtOnce: 0 })]);
        expect(companyMeetingsAtOnce(c)).toBe(1);
    });
});
