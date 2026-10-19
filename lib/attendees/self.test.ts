import { describe, test, expect } from "vitest";
import type { Attendee } from "@/types";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { isOwnParty, isSameAttendee } from "./self";

/**
 * Builds a minimal attendee with the given ids.
 *
 * @param {Partial<Attendee>} partial - Fields to set.
 * @returns {Attendee} The attendee.
 */
function att(partial: Partial<Attendee>): Attendee {
    return {
        id: partial.salesforceId ?? "",
        cventContactId: "",
        salesforceId: partial.salesforceId ?? "",
        accountId: partial.accountId ?? "",
        name: "",
        email: partial.email ?? "",
        phone: "",
        role: partial.role ?? "delegate",
        company: "",
        title: "",
        sponsorTier: null,
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: 2, requestedSponsorAccountIds: [] },
    };
}

describe("isSameAttendee", () => {
    test("matches on Salesforce id", () => {
        expect(
            isSameAttendee(
                att({ salesforceId: "d1", email: "a@x.com" }),
                att({ salesforceId: "d1", email: "other@x.com" }),
            ),
        ).toBe(true);
    });

    test("matches on email, ignoring case and spaces", () => {
        expect(
            isSameAttendee(
                att({ salesforceId: "d1", email: "Mary@X.com" }),
                att({ salesforceId: "", email: " mary@x.com " }),
            ),
        ).toBe(true);
    });

    test("matches a sponsor login to their own delegate record by email", () => {
        expect(
            isSameAttendee(
                att({ salesforceId: "d1", email: "mary@x.com", role: "delegate" }),
                att({ salesforceId: "s1", email: "mary@x.com", role: "sponsor" }),
            ),
        ).toBe(true);
    });

    test("does not match a different person", () => {
        expect(
            isSameAttendee(
                att({ salesforceId: "d1", email: "a@x.com" }),
                att({ salesforceId: "d2", email: "b@x.com" }),
            ),
        ).toBe(false);
    });

    test("does not treat two empty ids or emails as a match", () => {
        expect(
            isSameAttendee(
                att({ salesforceId: "", email: "" }),
                att({ salesforceId: "", email: "" }),
            ),
        ).toBe(false);
    });
});

describe("isOwnParty", () => {
    const pepsiRep = att({ salesforceId: "s1", email: "rep@pepsi.com", role: "sponsor", accountId: "acct-pepsi" });

    test("hides a delegate from the sponsor's own company", () => {
        const colleague = att({ salesforceId: "d1", email: "colleague@pepsi.com", accountId: "acct-pepsi" });
        expect(isOwnParty(colleague, pepsiRep)).toBe(true);
    });

    test("shows delegates from other companies", () => {
        const other = att({ salesforceId: "d2", email: "a@coke.com", accountId: "acct-coke" });
        expect(isOwnParty(other, pepsiRep)).toBe(false);
    });

    test("still hides the viewer themselves", () => {
        const sameEmail = att({ salesforceId: "d3", email: "rep@pepsi.com", accountId: "acct-other" });
        expect(isOwnParty(sameEmail, pepsiRep)).toBe(true);
    });

    test("does not hide everyone without an Account when the sponsor has none either", () => {
        const noAccountRep = att({ salesforceId: "s2", email: "rep@x.com", role: "sponsor", accountId: "" });
        const noAccountDelegate = att({ salesforceId: "d4", email: "d@y.com", accountId: "" });
        expect(isOwnParty(noAccountDelegate, noAccountRep)).toBe(false);
    });

    test("keeps delegates as individuals, so a delegate still sees colleagues", () => {
        const delegateViewer = att({ salesforceId: "d5", email: "me@acme.com", role: "delegate", accountId: "acct-acme" });
        const colleague = att({ salesforceId: "d6", email: "you@acme.com", accountId: "acct-acme" });
        expect(isOwnParty(colleague, delegateViewer)).toBe(false);
    });
});
