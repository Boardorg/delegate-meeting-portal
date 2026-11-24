import { describe, test, expect } from "vitest";
import type { Attendee } from "@/types";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { listDelegatesPage } from "./delegates";

// ---------------------------------------------------------------------------
// The admin delegates list shows the delegates sponsors see, searched,
// sorted and paged.
// ---------------------------------------------------------------------------

/**
 * Builds an attendee, a delegate unless the partial says otherwise.
 *
 * @param {string} id - The Salesforce id.
 * @param {Partial<Attendee>} [partial] - Fields to set.
 * @returns {Attendee} The attendee.
 */
function attendee(id: string, partial: Partial<Attendee> = {}): Attendee {
    return {
        id,
        cventContactId: `cvent-${id}`,
        cventCancelled: partial.cventCancelled,
        salesforceId: id,
        accountId: partial.accountId ?? `acct-${id}`,
        name: partial.name ?? id,
        email: partial.email ?? `${id}@example.com`,
        phone: "",
        role: partial.role ?? "delegate",
        company: partial.company ?? "Acme",
        title: "",
        sponsorTier: null,
        opportunityId: null,
        boothNo: null,
        purchasedMeetings: null,
        bonusMeetings: null,
        maximumMeetings: null,
        meetingsAtOnce: null,
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: null, requestedSponsorAccountIds: [] },
    };
}

/**
 * Lists the names on a page, in order.
 *
 * @param {ReturnType<typeof listDelegatesPage>} page - A page of rows.
 * @returns {string[]} The names.
 */
function names(page: ReturnType<typeof listDelegatesPage>): string[] {
    return page.rows.map((r) => r.name);
}

describe("listDelegatesPage", () => {
    test("lists only delegates sponsors see", () => {
        const page = listDelegatesPage([
            attendee("d1", { name: "Ann" }),
            attendee("d2", { name: "Cancelled", cventCancelled: true }),
            attendee("s1", { name: "Rep", role: "sponsor" }),
        ]);
        expect(names(page)).toEqual(["Ann"]);
        expect(page.total).toBe(1);
    });

    test("returns name, company and email for each row", () => {
        const page = listDelegatesPage([
            attendee("d1", { name: "Ann", company: "Acme", email: "ann@acme.com" }),
        ]);
        expect(page.rows).toEqual([
            { salesforceId: "d1", name: "Ann", company: "Acme", email: "ann@acme.com" },
        ]);
    });

    test("sorts by name A to Z by default", () => {
        const page = listDelegatesPage([
            attendee("d1", { name: "Cara" }),
            attendee("d2", { name: "Ann" }),
            attendee("d3", { name: "Ben" }),
        ]);
        expect(names(page)).toEqual(["Ann", "Ben", "Cara"]);
    });

    test("sorts by company descending, with name breaking ties", () => {
        const page = listDelegatesPage(
            [
                attendee("d1", { name: "Ben", company: "Acme" }),
                attendee("d2", { name: "Ann", company: "Acme" }),
                attendee("d3", { name: "Cara", company: "Zeta" }),
            ],
            { sortField: "company", sortDir: "desc" },
        );
        expect(names(page)).toEqual(["Cara", "Ann", "Ben"]);
    });

    test("sorts by email ascending", () => {
        const page = listDelegatesPage(
            [
                attendee("d1", { name: "Ann", email: "zed@example.com" }),
                attendee("d2", { name: "Ben", email: "amy@example.com" }),
            ],
            { sortField: "email", sortDir: "asc" },
        );
        expect(names(page)).toEqual(["Ben", "Ann"]);
    });

    test("searches name, company and email, ignoring case", () => {
        const list = [
            attendee("d1", { name: "Ann Lee", company: "Acme", email: "ann@acme.com" }),
            attendee("d2", { name: "Ben", company: "Globex", email: "ben@globex.com" }),
            attendee("d3", { name: "Cara", company: "Initech", email: "cara@lee.io" }),
        ];
        expect(names(listDelegatesPage(list, { q: "  LEE " }))).toEqual(["Ann Lee", "Cara"]);
        expect(names(listDelegatesPage(list, { q: "globex" }))).toEqual(["Ben"]);
        expect(listDelegatesPage(list, { q: "nobody" }).total).toBe(0);
    });

    test("pages the results and clamps a page past the end", () => {
        const list = ["A", "B", "C", "D", "E"].map((n) => attendee(n, { name: n }));
        const second = listDelegatesPage(list, { page: 2, pageSize: 2 });
        expect(names(second)).toEqual(["C", "D"]);
        expect(second.pageCount).toBe(3);
        expect(second.total).toBe(5);
        const past = listDelegatesPage(list, { page: 9, pageSize: 2 });
        expect(past.page).toBe(3);
        expect(names(past)).toEqual(["E"]);
    });

    test("does not reorder the attendee list it was given", () => {
        const list = [attendee("d1", { name: "Ben" }), attendee("d2", { name: "Ann" })];
        listDelegatesPage(list);
        expect(list.map((a) => a.name)).toEqual(["Ben", "Ann"]);
    });
});
