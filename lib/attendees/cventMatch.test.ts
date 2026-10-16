import { describe, test, expect } from "vitest";
import type { Attendee } from "@/types";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { dropSponsorDelegateRecords, matchCventAttendees } from "./cventMatch";

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

/**
 * Builds an attendee with a Cvent contact id already matched.
 *
 * @param {string} id - The attendee's id and salesforceId.
 * @param {"sponsor" | "delegate"} role - The attendee's role.
 * @param {string} cventContactId - The matched Cvent contact id.
 * @returns {Attendee} The attendee.
 */
function matched(
    id: string,
    role: "sponsor" | "delegate",
    cventContactId: string,
): Attendee {
    return { ...delegate(id, `${id}@x.com`), role, cventContactId };
}

describe("dropSponsorDelegateRecords", () => {
    test("removes the delegate copy of a sponsor rep and keeps the sponsor record", () => {
        const out = dropSponsorDelegateRecords([
            matched("s1", "sponsor", "c-rep"),
            matched("d1", "delegate", "c-rep"),
            matched("d2", "delegate", "c-other"),
        ]);
        expect(out.map((a) => a.id)).toEqual(["s1", "d2"]);
    });

    test("keeps every rep of a company even when they share nothing with delegates", () => {
        const out = dropSponsorDelegateRecords([
            matched("s1", "sponsor", "c1"),
            matched("s2", "sponsor", "c2"),
        ]);
        expect(out.map((a) => a.id)).toEqual(["s1", "s2"]);
    });

    test("does not treat a blank sponsor contact id as matching blank delegates", () => {
        const out = dropSponsorDelegateRecords([
            matched("s1", "sponsor", ""),
            matched("d1", "delegate", ""),
        ]);
        expect(out.map((a) => a.id)).toEqual(["s1", "d1"]);
    });
});
