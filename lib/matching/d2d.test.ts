import { describe, expect, test } from "vitest";
import type { Attendee, AttendeeProfile, Timeslot } from "@/types";
import type { MeetingKind } from "@/lib/events/meetingKinds";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import {
    D2D_PASS_NUMBER,
    d2dOrderWarning,
    runD2DMatching,
    startMs,
    type D2DInput,
} from "./d2d";
import { DEFAULT_MATCHING_SETTINGS } from "./settings";
import { sameCompany } from "./company";

// ---------------------------------------------------------------------------
// The D2D one-on-one engine.
// ---------------------------------------------------------------------------

const SETTINGS = DEFAULT_MATCHING_SETTINGS.d2d;

/** A profile that shares "Leadership Development" with every other built by this helper. */
const ALIKE: Partial<AttendeeProfile> = { meetingInterests: ["Leadership Development"] };

/**
 * Builds an eligible delegate: a completed profile, not conference-only.
 *
 * @param {string} id - The Salesforce id, also used as the company unless given.
 * @param {Partial<Attendee>} [partial] - Fields to override.
 * @param {Partial<AttendeeProfile>} [answers] - Profile answers. Defaults to ALIKE.
 * @returns {Attendee} The delegate.
 */
function delegate(id: string, partial: Partial<Attendee> = {}, answers: Partial<AttendeeProfile> = ALIKE): Attendee {
    return {
        id,
        cventContactId: `c-${id}`,
        salesforceId: id,
        accountId: `acct-${id}`,
        name: id,
        email: "",
        phone: "",
        role: "delegate",
        company: `Company ${id}`,
        title: "",
        sponsorTier: null,
        networkingProfileComplete: true,
        conferenceOnly: false,
        profile: { ...emptyProfile(), ...answers },
        scheduling: { maxSameCompanyMeetings: 2, requestedSponsorAccountIds: [] },
        ...partial,
    };
}

/**
 * Builds a timeslot.
 *
 * @param {string} id - The timeslot id.
 * @param {1 | 2} day - The event day.
 * @param {string} hhmm - The start time, on 2027-01-20 for Day 1 and 2027-01-21 for Day 2.
 * @param {MeetingKind} [kind] - The slot's meeting kind. Defaults to delegate_delegate.
 * @param {number} [capacity] - How many meetings it takes. Defaults to 10.
 * @returns {Timeslot} The timeslot.
 */
function slot(id: string, day: 1 | 2, hhmm: string, kind: MeetingKind = "delegate_delegate", capacity = 10): Timeslot {
    const date = day === 1 ? "2027-01-20" : "2027-01-21";
    return {
        id,
        day,
        startTime: `${date}T${hhmm}:00.000Z`,
        endTime: `${date}T${hhmm}:00.000Z`,
        capacity,
        locationId: `loc-${id}`,
        appointmentTypeId: kind,
        appointmentTypeName: kind,
        kind,
    };
}

/**
 * Builds engine input with sensible empty defaults.
 *
 * @param {Partial<D2DInput>} partial - The parts to set.
 * @returns {D2DInput} The input.
 */
function input(partial: Partial<D2DInput>): D2DInput {
    return {
        attendees: [],
        s2dCountById: new Map(),
        existingD2D: [],
        busyById: new Map(),
        timeslots: [],
        settings: SETTINGS,
        now: 1,
        ...partial,
    };
}

/**
 * Counts each delegate's meetings.
 *
 * @param {{ attendeeA: string; attendeeB: string }[]} meetings - The meetings.
 * @returns {Map<string, number>} The count per delegate.
 */
function countById(meetings: { attendeeA: string; attendeeB: string }[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const m of meetings) for (const id of [m.attendeeA, m.attendeeB]) out.set(id, (out.get(id) ?? 0) + 1);
    return out;
}

const MANY_SLOTS = [
    slot("d1a", 1, "09:00"),
    slot("d1b", 1, "10:00"),
    slot("d1c", 1, "11:00"),
    slot("d2a", 2, "09:00"),
    slot("d2b", 2, "10:00"),
    slot("d2c", 2, "11:00"),
];

describe("runD2DMatching", () => {
    test("criterion 6: only delegates with a completed profile are matched, and conference-only delegates never are", () => {
        const result = runD2DMatching(input({
            attendees: [
                delegate("a"),
                delegate("b"),
                delegate("incomplete", { networkingProfileComplete: false }),
                delegate("conf", { conferenceOnly: true }),
                delegate("conf2", { conferenceOnly: true, networkingProfileComplete: true }),
            ],
            timeslots: MANY_SLOTS,
        }));
        const matched = new Set(result.meetings.flatMap((m) => [m.attendeeA, m.attendeeB]));
        expect([...matched].sort()).toEqual(["a", "b"]);
        expect(result.excluded).toEqual([
            { delegateId: "incomplete", reason: "incomplete_profile" },
            { delegateId: "conf", reason: "conference_only" },
            { delegateId: "conf2", reason: "conference_only" },
        ]);
    });

    test("criterion 7: no pair has two people from the same company, by Account id or by name", () => {
        const result = runD2DMatching(input({
            attendees: [
                delegate("a", { accountId: "acct-1", company: "Acme" }),
                delegate("b", { accountId: "acct-1", company: "Acme" }),
                delegate("c", { accountId: "", company: " ACME " }),
                delegate("d", { accountId: "acct-9", company: "acme" }),
                delegate("e", { accountId: "acct-5", company: "Globex" }),
            ],
            timeslots: MANY_SLOTS,
        }));
        const byId = new Map(["a", "b", "c", "d", "e"].map((id) => [id, id]));
        expect(result.meetings.length).toBeGreaterThan(0);
        for (const m of result.meetings) {
            expect(m.attendeeA === "e" || m.attendeeB === "e").toBe(true);
            expect(byId.has(m.attendeeA)).toBe(true);
        }
        expect(sameCompany({ accountId: "", company: " ACME " }, { accountId: "acct-9", company: "acme" })).toBe(true);
    });

    test("criterion 8: a delegate with no S2D meetings gets at most 4, and one with S2D meetings at most 5 in total", () => {
        const many = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => delegate(id));
        const slots = Array.from({ length: 10 }, (_, i) => slot(`s${i}`, 1, `${String(8 + i).padStart(2, "0")}:00`));
        const result = runD2DMatching(input({
            attendees: many,
            s2dCountById: new Map([["a", 2]]),
            timeslots: slots,
        }));
        const counts = countById(result.meetings);
        expect(counts.get("a")).toBe(3);
        for (const id of ["b", "c", "d", "e", "f", "g", "h"]) {
            expect(counts.get(id) ?? 0).toBeLessThanOrEqual(4);
        }
        expect(Math.max(...[...counts.values()])).toBe(4);
    });

    test("criterion 8: a delegate already at their cap from S2D meetings gets no D2D meeting", () => {
        const result = runD2DMatching(input({
            attendees: [delegate("a"), delegate("b")],
            s2dCountById: new Map([["a", 5]]),
            timeslots: MANY_SLOTS,
        }));
        expect(result.meetings).toEqual([]);
        expect(result.unmatched.map((u) => u.delegateId)).toEqual(["b"]);
    });

    test("criterion 9: no delegate is booked twice in one slot, including against S2D meetings and Cvent-only appointments", () => {
        const slots = [slot("x", 1, "09:00"), slot("y", 1, "10:00"), slot("z", 1, "11:00")];
        const result = runD2DMatching(input({
            attendees: [delegate("a"), delegate("b"), delegate("c")],
            // a has an S2D meeting at 09:00, and b a Cvent-only appointment at 10:00.
            busyById: new Map([
                ["a", new Set([startMs(slots[0].startTime)])],
                ["b", new Set([startMs(slots[1].startTime)])],
            ]),
            timeslots: slots,
        }));
        const seen = new Set<string>();
        for (const m of result.meetings) {
            const ms = startMs(slots.find((s) => s.id === m.timeslotId)!.startTime);
            for (const id of [m.attendeeA, m.attendeeB]) {
                const key = `${id}@${ms}`;
                expect(seen.has(key)).toBe(false);
                seen.add(key);
            }
        }
        expect(seen.has(`a@${startMs(slots[0].startTime)}`)).toBe(false);
        expect(seen.has(`b@${startMs(slots[1].startTime)}`)).toBe(false);
        expect(result.meetings).toHaveLength(3);
    });

    test("criterion 10: Day 1 slots are used first", () => {
        const result = runD2DMatching(input({
            attendees: [delegate("a"), delegate("b")],
            timeslots: [slot("late", 2, "08:00"), slot("early", 1, "16:00")],
        }));
        expect(result.meetings.map((m) => [m.timeslotId, m.day])).toEqual([["early", 1]]);
    });

    test("criterion 10: a delegate with more than one D2D meeting has at least one on Day 1", () => {
        // a is busy for the only Day 1 slot, so a can have one Day 2 meeting but not two.
        const slots = [slot("d1", 1, "09:00"), slot("d2a", 2, "09:00"), slot("d2b", 2, "10:00")];
        const result = runD2DMatching(input({
            attendees: [delegate("a"), delegate("b"), delegate("c")],
            busyById: new Map([["a", new Set([startMs(slots[0].startTime)])]]),
            timeslots: slots,
        }));
        const days = new Map<string, number[]>();
        for (const m of result.meetings) {
            for (const id of [m.attendeeA, m.attendeeB]) days.set(id, [...(days.get(id) ?? []), m.day]);
        }
        for (const list of days.values()) {
            if (list.length > 1) expect(list).toContain(1);
        }
        expect(days.get("a")).toEqual([2]);
    });

    test("criterion 11: only delegate_delegate slots are used", () => {
        const result = runD2DMatching(input({
            attendees: [delegate("a"), delegate("b"), delegate("c"), delegate("d")],
            timeslots: [
                slot("s2d", 1, "08:00", "sponsor_delegate"),
                slot("group", 1, "08:30", "delegate_group"),
                slot("ignored", 1, "08:45", "ignore"),
                slot("d2d", 1, "09:00", "delegate_delegate"),
            ],
        }));
        expect(result.meetings.length).toBeGreaterThan(0);
        expect(result.meetings.every((m) => m.timeslotId === "d2d")).toBe(true);
    });

    test("criterion 12: a pair below the minimum score is marked weak, and a delegate with no acceptable partner is unmatched", () => {
        const strong = { meetingInterests: ["Leadership Development"], interestAreas: ["Coaching"], systemsAndPlatforms: ["Workday"] };
        const result = runD2DMatching(input({
            attendees: [
                delegate("a", {}, strong),
                delegate("b", {}, strong),
                delegate("c", {}, { systemsAndPlatforms: ["Go1"], priorityInitiative: "X" }),
                delegate("d", {}, { systemsAndPlatforms: ["Go1"], priorityInitiative: "Y" }),
                delegate("loner", {}, { meetingInterests: ["Nobody Else"] }),
            ],
            timeslots: [slot("s", 1, "09:00")],
            settings: { ...SETTINGS, minScore: 30 },
        }));
        const byPair = new Map(result.meetings.map((m) => [`${m.attendeeA}|${m.attendeeB}`, m]));
        expect(byPair.get("a|b")?.weak).toBe(false);
        expect(byPair.get("c|d")?.weak).toBe(true);
        expect(result.unmatched).toEqual([{ delegateId: "loner", reason: "no_partner" }]);
    });

    test("lists a delegate whose partners were all full as unmatched for want of a slot", () => {
        const result = runD2DMatching(input({
            attendees: [delegate("a"), delegate("b"), delegate("c")],
            timeslots: [slot("only", 1, "09:00", "delegate_delegate", 1)],
        }));
        expect(result.meetings).toHaveLength(1);
        expect(result.unmatched).toEqual([{ delegateId: "c", reason: "no_slot" }]);
    });

    test("books the best pair first and makes the lower Salesforce id the host", () => {
        const result = runD2DMatching(input({
            attendees: [
                delegate("z", {}, { meetingInterests: ["A", "B"], systemsAndPlatforms: ["W"] }),
                delegate("m", {}, { meetingInterests: ["A", "B"], systemsAndPlatforms: ["W"] }),
                delegate("q", {}, { meetingInterests: ["A"] }),
            ],
            timeslots: [slot("s1", 1, "09:00", "delegate_delegate", 1)],
        }));
        expect(result.meetings).toHaveLength(1);
        const m = result.meetings[0];
        expect([m.attendeeA, m.attendeeB]).toEqual(["m", "z"]);
        expect(m.passNumber).toBe(D2D_PASS_NUMBER);
        expect(m.matchKind).toBe("profile_match");
        expect(m.locationId).toBe("loc-s1");
    });

    test("doesn't pair two delegates who already meet, and counts kept meetings toward the cap", () => {
        const result = runD2DMatching(input({
            attendees: [delegate("a"), delegate("b"), delegate("c")],
            existingD2D: [
                { attendeeA: "a", attendeeB: "b", day: 1 },
                { attendeeA: "a", attendeeB: "x", day: 1 },
                { attendeeA: "a", attendeeB: "y", day: 1 },
                { attendeeA: "a", attendeeB: "w", day: 1 },
            ],
            timeslots: MANY_SLOTS,
        }));
        const pairs = result.meetings.map((m) => `${m.attendeeA}|${m.attendeeB}`);
        expect(pairs).toEqual(["b|c"]);
    });
});

describe("d2dOrderWarning", () => {
    test("criterion 22: warns when no S2D meetings exist, and says nothing once they do", () => {
        expect(d2dOrderWarning(0)).toMatch(/No sponsor meetings are scheduled yet/);
        expect(d2dOrderWarning(3)).toBeNull();
    });
});
