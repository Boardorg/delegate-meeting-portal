import { describe, test, expect } from "vitest";
import type { Attendee } from "@/types";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import {
    hostContactIdsForMeeting,
    sameMeetingTime,
    sameTimeMeetingIds,
} from "./hostSplit";

// ---------------------------------------------------------------------------
// Splitting a company's reps across its same-time meetings.
// ---------------------------------------------------------------------------

/**
 * Builds a rep who can host.
 *
 * @param {string} salesforceId - The rep's Salesforce id.
 * @returns {Attendee} The rep, with Cvent contact id `c-<salesforceId>`.
 */
function rep(salesforceId: string): Attendee {
    return {
        id: salesforceId,
        cventContactId: `c-${salesforceId}`,
        salesforceId,
        accountId: "acct-a",
        name: salesforceId,
        email: "",
        phone: "",
        role: "sponsor",
        company: "A",
        title: "",
        sponsorTier: "standard",
        profile: emptyProfile(),
        scheduling: { maxSameCompanyMeetings: null, requestedSponsorAccountIds: [] },
    };
}

const SLOTS = new Map([
    ["ts-9a", { startTime: "2026-01-20T09:00:00Z" }],
    ["ts-9b", { startTime: "2026-01-20T09:00:00.000Z" }],
    ["ts-10", { startTime: "2026-01-20T10:00:00Z" }],
]);

describe("hostContactIdsForMeeting", () => {
    test("one meeting at the time gets every rep who can host", () => {
        expect(hostContactIdsForMeeting([rep("s2"), rep("s1")], "m1", ["m1"])).toEqual(["c-s1", "c-s2"]);
    });

    test("two meetings and three reps deal the reps out by Salesforce id, with no rep on both", () => {
        const reps = [rep("s3"), rep("s1"), rep("s2")];
        const ids = ["m-b", "m-a"];

        const a = hostContactIdsForMeeting(reps, "m-a", ids);
        const b = hostContactIdsForMeeting(reps, "m-b", ids);

        expect(a).toEqual(["c-s1", "c-s3"]);
        expect(b).toEqual(["c-s2"]);
        expect(a.filter((id) => b.includes(id))).toEqual([]);
    });

    test("gives the same split every time, whatever order things arrive in", () => {
        const first = hostContactIdsForMeeting([rep("s1"), rep("s2"), rep("s3")], "m-b", ["m-a", "m-b"]);
        const again = hostContactIdsForMeeting([rep("s3"), rep("s2"), rep("s1")], "m-b", ["m-b", "m-a"]);
        expect(again).toEqual(first);
    });

    test("a meeting gets no host when there are more meetings than reps", () => {
        expect(hostContactIdsForMeeting([rep("s1")], "m-b", ["m-a", "m-b"])).toEqual([]);
    });
});

describe("sameTimeMeetingIds", () => {
    test("counts the company's meetings at the same start time, in any slot", () => {
        const meetings = [
            { id: "m1", attendeeA: "acct-a", timeslotId: "ts-9a" },
            { id: "m2", attendeeA: "acct-a", timeslotId: "ts-9b" },
            { id: "m3", attendeeA: "acct-a", timeslotId: "ts-10" },
            { id: "m4", attendeeA: "acct-other", timeslotId: "ts-9a" },
        ];
        expect(sameTimeMeetingIds(meetings[0], meetings, SLOTS)).toEqual(["m1", "m2"]);
    });

    test("meetings in a slot Cvent no longer lists still match by slot id", () => {
        const a = { id: "m1", attendeeA: "acct-a", timeslotId: "ts-full" };
        const b = { id: "m2", attendeeA: "acct-a", timeslotId: "ts-full" };
        expect(sameMeetingTime(a, b, SLOTS)).toBe(true);
        expect(sameMeetingTime(a, { ...b, timeslotId: "ts-9a" }, SLOTS)).toBe(false);
    });
});
