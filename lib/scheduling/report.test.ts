import { describe, test, expect } from "vitest";
import type { Attendee, MeetingRequest } from "@/types";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { buildSchedulerReport } from "./report";
import { pairKey } from "./helpers";

/**
 * Builds a minimal attendee for report tests.
 *
 * @param {Pick<Attendee, "salesforceId" | "role"> & Partial<Attendee>} partial - Fields to set.
 * @returns {Attendee} The attendee.
 */
function att(
    partial: Pick<Attendee, "salesforceId" | "role"> & Partial<Attendee>,
): Attendee {
    return {
        id: partial.salesforceId,
        cventContactId: "",
        cventCancelled: partial.cventCancelled,
        salesforceId: partial.salesforceId,
        accountId: partial.accountId ?? "",
        name: partial.name ?? partial.salesforceId,
        email: "",
        phone: "",
        role: partial.role,
        company: partial.company ?? "",
        title: "",
        sponsorTier: null,
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: 2, requestedSponsorAccountIds: [] },
    };
}

/**
 * Builds the report for one request with nothing scheduled.
 *
 * @param {Attendee[]} attendees - The attendee list given to the report.
 * @param {MeetingRequest} request - The single request to classify.
 * @returns The report's only unscheduled reason.
 */
function reasonFor(attendees: Attendee[], request: MeetingRequest) {
    const report = buildSchedulerReport({
        eventCode: "EVT",
        generatedAt: "2025-01-01T00:00:00Z",
        attendees,
        requests: [request],
        reconciled: [],
        skipReasons: new Map(),
        reconciledOutPairs: new Set(),
        preexistingPairs: new Set(),
    });
    return report.unscheduledRequests[0].reason;
}

const request: MeetingRequest = {
    id: "r1",
    requesterId: "acct-acme",
    targetId: "d1",
    rank: 5,
};

describe("buildSchedulerReport — cancelled attendees", () => {
    test("labels a request to a cancelled delegate as attendee_cancelled", () => {
        const reason = reasonFor(
            [
                att({ salesforceId: "s1", role: "sponsor", accountId: "acct-acme", company: "Acme" }),
                att({ salesforceId: "d1", role: "delegate", cventCancelled: true }),
            ],
            request,
        );
        expect(reason).toBe("attendee_cancelled");
    });

    test("labels a request from a company whose reps all cancelled as attendee_cancelled", () => {
        const reason = reasonFor(
            [
                att({ salesforceId: "s1", role: "sponsor", accountId: "acct-acme", company: "Acme", cventCancelled: true }),
                att({ salesforceId: "d1", role: "delegate" }),
            ],
            request,
        );
        expect(reason).toBe("attendee_cancelled");
    });

    test("does not blame cancellation when only some of the company's reps cancelled", () => {
        const reason = reasonFor(
            [
                att({ salesforceId: "s1", role: "sponsor", accountId: "acct-acme", company: "Acme", cventCancelled: true }),
                att({ salesforceId: "s2", role: "sponsor", accountId: "acct-acme", company: "Acme" }),
                att({ salesforceId: "d1", role: "delegate" }),
            ],
            request,
        );
        expect(reason).toBe("no_pass_match");
    });
});

describe("buildSchedulerReport — unmapped appointment types", () => {
    /**
     * Builds an empty report with the given unmapped type names.
     *
     * @param {string[] | undefined} unmapped - Names to pass, or undefined to leave them out.
     * @returns The report.
     */
    function reportWith(unmapped: string[] | undefined) {
        return buildSchedulerReport({
            eventCode: "EVT",
            generatedAt: "2025-01-01T00:00:00Z",
            attendees: [],
            requests: [],
            reconciled: [],
            skipReasons: new Map(),
            reconciledOutPairs: new Set(),
            preexistingPairs: new Set(),
            unmappedAppointmentTypes: unmapped,
        });
    }

    test("lists each unmapped type by name", () => {
        expect(
            reportWith(["Delegate Group Meetings", "Themed Lunches (Round Tables)"])
                .unmappedAppointmentTypes,
        ).toEqual(["Delegate Group Meetings", "Themed Lunches (Round Tables)"]);
    });

    test("lists none when the caller passes none", () => {
        expect(reportWith(undefined).unmappedAppointmentTypes).toEqual([]);
    });
});

describe("buildSchedulerReport — booth problems", () => {
    // Every booth problem, each tried on its own.
    const PROBLEMS = [
        "no_booth",
        "booth_not_found",
        "booth_conflict",
        "multiple_opportunities",
        "no_package_meetings",
    ] as const;

    /**
     * Builds the report for one request from a company with one booth problem.
     *
     * @param {(typeof PROBLEMS)[number]} problem - The company's booth problem.
     * @param {Set<string>} [preexistingPairs] - Pairs that already meet in Cvent. Defaults to none.
     * @returns The report.
     */
    function reportFor(problem: (typeof PROBLEMS)[number], preexistingPairs = new Set<string>()) {
        return buildSchedulerReport({
            eventCode: "EVT",
            generatedAt: "2025-01-01T00:00:00Z",
            attendees: [
                att({ salesforceId: "s1", role: "sponsor", accountId: "acct-acme", company: "Acme" }),
                att({ salesforceId: "d1", role: "delegate" }),
            ],
            requests: [request],
            reconciled: [],
            skipReasons: new Map(),
            reconciledOutPairs: new Set(),
            preexistingPairs,
            companyBooths: new Map([
                [
                    "acct-acme",
                    {
                        accountId: "acct-acme",
                        boothNo: "3",
                        location: null,
                        source: null,
                        manualLocationId: null,
                        automaticLocation: null,
                        problems: [problem],
                    },
                ],
            ]),
        });
    }

    test.each(PROBLEMS)("gives %s as the reason for the company's requests", (problem) => {
        expect(reportFor(problem).unscheduledRequests[0].reason).toBe(problem);
    });

    test("gives already_scheduled ahead of a booth problem when the pair already meets in Cvent", () => {
        const report = reportFor("no_booth", new Set([pairKey("acct-acme", "d1")]));
        expect(report.unscheduledRequests[0].reason).toBe("already_scheduled");
    });

    test("lists the company and its problem", () => {
        expect(reportFor("no_booth").boothProblems).toEqual([
            {
                accountId: "acct-acme",
                company: "Acme",
                boothNo: "3",
                problem: "no_booth",
                problems: ["no_booth"],
            },
        ]);
    });

    test("lists no booth problems when the caller passes no booths", () => {
        const report = buildSchedulerReport({
            eventCode: "EVT",
            generatedAt: "2025-01-01T00:00:00Z",
            attendees: [],
            requests: [],
            reconciled: [],
            skipReasons: new Map(),
            reconciledOutPairs: new Set(),
            preexistingPairs: new Set(),
        });
        expect(report.boothProblems).toEqual([]);
    });
});
