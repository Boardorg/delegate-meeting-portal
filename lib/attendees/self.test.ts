import { describe, test, expect } from "vitest";
import type { Attendee } from "@/types";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { isSameAttendee } from "./self";

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
        accountId: "",
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
