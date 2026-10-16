import { describe, test, expect } from "vitest";
import type { Attendee } from "@/types";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { matchCventAttendees } from "./cventMatch";

/**
 * Builds a minimal delegate with the given email.
 *
 * @param {string} id - The attendee's id and salesforceId.
 * @param {string} email - The attendee's Salesforce email.
 * @returns {Attendee} The attendee.
 */
function delegate(id: string, email: string): Attendee {
    return {
        id,
        cventContactId: "",
        salesforceId: id,
        accountId: "",
        name: id,
        email,
        phone: "",
        role: "delegate",
        company: "",
        title: "",
        sponsorTier: null,
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: 2, requestedSponsorAccountIds: [] },
    };
}

describe("matchCventAttendees", () => {
    test("drops attendees with no Cvent registration", () => {
        const out = matchCventAttendees(
            [delegate("d1", "a@x.com"), delegate("d2", "b@x.com")],
            [{ email: "a@x.com", contactId: "c1", cancelled: false }],
        );
        expect(out.map((a) => a.id)).toEqual(["d1"]);
        expect(out[0].cventContactId).toBe("c1");
        expect(out[0].cventCancelled).toBe(false);
    });

    test("keeps a cancelled attendee and flags them", () => {
        const out = matchCventAttendees(
            [delegate("d1", "a@x.com")],
            [{ email: "a@x.com", contactId: "c1", cancelled: true }],
        );
        expect(out).toHaveLength(1);
        expect(out[0].cventCancelled).toBe(true);
    });

    test("prefers an active registration over a cancelled one for the same email", () => {
        const out = matchCventAttendees(
            [delegate("d1", "a@x.com")],
            [
                { email: "a@x.com", contactId: "old", cancelled: true },
                { email: "a@x.com", contactId: "new", cancelled: false },
            ],
        );
        expect(out[0].cventContactId).toBe("new");
        expect(out[0].cventCancelled).toBe(false);
    });

    test("matches Salesforce emails case-insensitively", () => {
        const out = matchCventAttendees(
            [delegate("d1", "Mary@X.com")],
            [{ email: "mary@x.com", contactId: "c1", cancelled: false }],
        );
        expect(out).toHaveLength(1);
    });
});
