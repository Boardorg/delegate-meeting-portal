import { describe, test, expect } from "vitest";
import type { Attendee } from "@/types";
import { meetingDataToAttendees, type MeetingDataRecord } from "@/lib/salesforce/attendeeMapper";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { hostingReps, sponsorCompaniesByAccountId } from "./companies";

// ---------------------------------------------------------------------------
// Sponsor companies are their Opportunity's account, with the Opportunity's
// booth and meeting counts resolved once from the reps.
// ---------------------------------------------------------------------------

/**
 * Builds a raw sponsor record as the Salesforce sponsor query returns it.
 *
 * @param {string} id - The Attendee__c id.
 * @param {string} contactAccount - The rep's Contact account id.
 * @param {string} contactAccountName - The rep's Contact account name.
 * @param {Partial<NonNullable<MeetingDataRecord["Registration__r"]>>} opportunity - Opportunity fields.
 * @param {string} opportunityId - The Opportunity id.
 * @returns {MeetingDataRecord} The record.
 */
function sponsorRecord(
    id: string,
    contactAccount: string,
    contactAccountName: string,
    opportunity: Partial<NonNullable<MeetingDataRecord["Registration__r"]>>,
    opportunityId = "006-edx",
): MeetingDataRecord {
    return {
        Id: id,
        Delegate__r: {
            FirstName: id,
            LastName: "Rep",
            AccountId: contactAccount,
            Account: { Name: contactAccountName },
        },
        Registration__c: opportunityId,
        Registration__r: {
            Sponsorship_Package__c: "Gold",
            AccountId: "001-edx",
            Account: { Name: "edX Enterprise" },
            ...opportunity,
        },
    };
}

/**
 * Builds a mapped sponsor rep.
 *
 * @param {Partial<Attendee>} partial - Fields to set.
 * @returns {Attendee} The rep.
 */
function rep(partial: Partial<Attendee>): Attendee {
    const id = partial.salesforceId ?? "s1";
    return {
        id,
        cventContactId: partial.cventContactId ?? "",
        cventCancelled: partial.cventCancelled,
        salesforceId: id,
        accountId: partial.accountId ?? "acct-1",
        name: id,
        email: "",
        phone: "",
        role: "sponsor",
        company: "Acme",
        title: "",
        sponsorTier: "standard",
        opportunityId: partial.opportunityId ?? null,
        boothNo: partial.boothNo ?? null,
        purchasedMeetings: partial.purchasedMeetings ?? null,
        bonusMeetings: null,
        maximumMeetings: null,
        meetingsAtOnce: null,
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: null, requestedSponsorAccountIds: [] },
    };
}

describe("sponsor companies from the Opportunity", () => {
    test("two reps on different Contact accounts but one Opportunity are one company, named for the Opportunity's account", () => {
        const attendees = meetingDataToAttendees(
            {
                delegates: [],
                sponsors: [
                    sponsorRecord("a01", "001-2u", "2U", { Booth_No__c: " 3 ", Meetings__c: 4 }),
                    sponsorRecord("a02", "001-edx", "edX Enterprise", { Booth_No__c: " 3 ", Meetings__c: 4 }),
                ],
            },
            false,
        );

        const companies = sponsorCompaniesByAccountId(attendees);

        expect([...companies.keys()]).toEqual(["001-edx"]);
        const company = companies.get("001-edx")!;
        expect(company.name).toBe("edX Enterprise");
        expect(company.reps.map((r) => r.salesforceId)).toEqual(["a01", "a02"]);
        expect(company.opportunityId).toBe("006-edx");
        expect(company.boothNo).toBe("3");
        expect(company.purchasedMeetings).toBe(4);
        expect(company.multipleOpportunities).toBe(false);
    });

    test("reads blank counts as null and keeps a 0", () => {
        const [a] = meetingDataToAttendees(
            {
                delegates: [],
                sponsors: [
                    sponsorRecord("a01", "001-edx", "edX Enterprise", {
                        Booth_No__c: "",
                        Meetings__c: 0,
                        Cvent_Bonus_Meetings__c: null,
                        Cvent_Maximum_Meetings__c: undefined,
                        Cvent_Number_Diaries__c: 2,
                    }),
                ],
            },
            false,
        );

        expect(a).toMatchObject({
            boothNo: null,
            purchasedMeetings: 0,
            bonusMeetings: null,
            maximumMeetings: null,
            meetingsAtOnce: 2,
        });
    });

    test("groups reps by the Opportunity id when the Opportunity has no account", () => {
        const companies = sponsorCompaniesByAccountId([
            rep({ salesforceId: "s1", accountId: "", opportunityId: "opp-1" }),
            rep({ salesforceId: "s2", accountId: "", opportunityId: "opp-1" }),
            rep({ salesforceId: "s3", accountId: "", opportunityId: null }),
        ]);
        expect([...companies.keys()].sort()).toEqual(["opp-1", "s3"]);
        expect(companies.get("opp-1")!.reps.map((r) => r.salesforceId)).toEqual(["s1", "s2"]);
    });

    test("marks a company whose reps are on more than one Opportunity", () => {
        const companies = sponsorCompaniesByAccountId([
            rep({ salesforceId: "s1", opportunityId: "opp-1" }),
            rep({ salesforceId: "s2", opportunityId: "opp-2" }),
        ]);
        expect(companies.get("acct-1")!.multipleOpportunities).toBe(true);
    });

    test("resolves the values from the first rep by Salesforce id that has an Opportunity", () => {
        const companies = sponsorCompaniesByAccountId([
            rep({ salesforceId: "s2", opportunityId: "opp-1", boothNo: "4", purchasedMeetings: 3 }),
            rep({ salesforceId: "s1", opportunityId: null }),
        ]);
        expect(companies.get("acct-1")).toMatchObject({
            opportunityId: "opp-1",
            boothNo: "4",
            purchasedMeetings: 3,
            multipleOpportunities: false,
        });
    });
});

describe("hostingReps", () => {
    test("lists linked, non-cancelled reps by Salesforce id", () => {
        const company = sponsorCompaniesByAccountId([
            rep({ salesforceId: "s3", cventContactId: "c3" }),
            rep({ salesforceId: "s1", cventContactId: "c1" }),
            rep({ salesforceId: "s2", cventContactId: "" }),
            rep({ salesforceId: "s4", cventContactId: "c4", cventCancelled: true }),
        ]).get("acct-1")!;

        expect(hostingReps(company).map((r) => r.salesforceId)).toEqual(["s1", "s3"]);
    });
});
