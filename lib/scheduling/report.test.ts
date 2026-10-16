import { describe, test, expect } from "vitest";
import type { Attendee, MeetingRequest } from "@/types";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import { buildSchedulerReport } from "./report";

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
