import { describe, expect, test } from "vitest";
import type { Attendee, AttendeeProfile, Timeslot } from "@/types";
import { emptyProfile } from "@/lib/attendees/formatProfile";
import {
    DEFAULT_ROUNDTABLE_DESCRIPTION,
    checkSeatMove,
    roundtableHostId,
    roundtableOrderWarning,
    roundtableSlots,
    runRoundtableGrouping,
    type RoundtableInput,
} from "./roundtables";
import { DEFAULT_MATCHING_SETTINGS } from "./settings";
import { sameCompany } from "./company";
import type { DelegateCounts } from "./delegateMeetings";

// ---------------------------------------------------------------------------
// The roundtable grouping engine and the move checks.
// ---------------------------------------------------------------------------

const SETTINGS = DEFAULT_MATCHING_SETTINGS.roundtables;
const INTERESTS = ["Leadership Development", "Coaching", "Onboarding", "Analytics"];

/**
 * Builds a delegate with no meetings.
 *
 * @param {string} id - The Salesforce id.
 * @param {Partial<Attendee>} [partial] - Fields to override.
 * @param {Partial<AttendeeProfile>} [answers] - Profile answers. Defaults to one interest picked from the id.
 * @returns {Attendee} The delegate.
 */
function delegate(id: string, partial: Partial<Attendee> = {}, answers?: Partial<AttendeeProfile>): Attendee {
    const n = Number(id.replace(/\D/g, "")) || 0;
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
        profile: { ...emptyProfile(), meetingInterests: [INTERESTS[n % INTERESTS.length]], ...answers },
        scheduling: { maxSameCompanyMeetings: 2, requestedSponsorAccountIds: [] },
        ...partial,
    };
}

/**
 * Builds a delegate_group table slot.
 *
 * @param {string} id - The timeslot id.
 * @param {1 | 2} day - The event day.
 * @param {string} location - The location id.
 * @returns {Timeslot} The slot.
 */
function table(id: string, day: 1 | 2, location: string): Timeslot {
    const start = day === 1 ? "2027-01-20T15:00:00.000Z" : "2027-01-21T09:00:00.000Z";
    return { id, day, startTime: start, endTime: start, capacity: 1, locationId: location, appointmentTypeId: "g", appointmentTypeName: "Group", kind: "delegate_group" };
}

const FOUR_TABLES = [table("rt1", 1, "loc-1"), table("rt2", 1, "loc-2"), table("rt3", 2, "loc-3"), table("rt4", 2, "loc-4")];

/**
 * Builds engine input.
 *
 * @param {Partial<RoundtableInput>} partial - The parts to set.
 * @returns {RoundtableInput} The input.
 */
function input(partial: Partial<RoundtableInput>): RoundtableInput {
    return { attendees: [], counts: new Map(), timeslots: FOUR_TABLES, settings: SETTINGS, ...partial };
}

/**
 * Builds n delegates d1 to dn.
 *
 * @param {number} n - How many.
 * @returns {Attendee[]} The delegates.
 */
function delegates(n: number): Attendee[] {
    return Array.from({ length: n }, (_, i) => delegate(`d${i + 1}`));
}

describe("runRoundtableGrouping", () => {
    test("criterion 14: only delegates with no S2D or D2D meetings are grouped, and conference-only delegates never are", () => {
        const counts = new Map<string, DelegateCounts>([
            ["s2d", { s2d: 1, d2d: 0 }],
            ["d2d", { s2d: 0, d2d: 1 }],
            ["cventOnly", { s2d: 0, d2d: 1 }],
        ]);
        const result = runRoundtableGrouping(input({
            attendees: [
                delegate("free1"),
                delegate("free2"),
                delegate("s2d"),
                delegate("d2d"),
                delegate("cventOnly"),
                delegate("conf", { conferenceOnly: true }),
            ],
            counts,
        }));
        const placed = new Set(result.groups.flatMap((g) => [...g.seated, ...g.alternates].map((s) => s.delegateId)));
        expect([...placed].sort()).toEqual(["free1", "free2"]);
        expect(result.excluded.map((e) => [e.delegateId, e.reason])).toEqual([
            ["s2d", "has_meetings"],
            ["d2d", "has_meetings"],
            ["cventOnly", "has_meetings"],
            ["conf", "conference_only"],
        ]);
    });

    test("criterion 15: each delegate_group slot is one table, and 4 tables of 5 seat at most 20 with the rest unassigned", () => {
        const result = runRoundtableGrouping(input({
            attendees: delegates(30),
            timeslots: [...FOUR_TABLES, { ...table("s2d", 1, "loc-9"), kind: "sponsor_delegate" }],
        }));
        expect(result.groups.map((g) => g.timeslotId)).toEqual(["rt1", "rt2", "rt3", "rt4"]);
        const seated = result.groups.flatMap((g) => g.seated);
        expect(seated).toHaveLength(20);
        expect(result.groups.every((g) => g.seated.length === 5 && !g.short)).toBe(true);
        expect(result.groups.every((g) => g.alternates.length === 2)).toBe(true);
        expect(result.unassigned).toHaveLength(2);
    });

    test("criterion 16: no table seats two people from the same company", () => {
        const sameCo = Array.from({ length: 10 }, (_, i) =>
            delegate(`x${i}`, { accountId: i < 6 ? "acct-big" : `acct-${i}`, company: i < 6 ? "BigCo" : `Co ${i}` }),
        );
        const result = runRoundtableGrouping(input({ attendees: sameCo, timeslots: FOUR_TABLES.slice(0, 2) }));
        const byId = new Map(sameCo.map((a) => [a.salesforceId, a]));
        for (const g of result.groups) {
            const people = g.seated.map((s) => byId.get(s.delegateId)!);
            for (let i = 0; i < people.length; i++) {
                for (let j = i + 1; j < people.length; j++) expect(sameCompany(people[i], people[j])).toBe(false);
            }
        }
        // Only 2 BigCo people can be seated, one per table.
        const seatedBig = result.groups.flatMap((g) => g.seated).filter((s) => byId.get(s.delegateId)!.company === "BigCo");
        expect(seatedBig).toHaveLength(2);
    });

    test("criterion 17: each table gets 2 alternates, and no delegate is in more than one table", () => {
        const result = runRoundtableGrouping(input({ attendees: delegates(40) }));
        const all = result.groups.flatMap((g) => [...g.seated, ...g.alternates].map((s) => s.delegateId));
        expect(new Set(all).size).toBe(all.length);
        expect(result.groups.every((g) => g.alternates.length === 2)).toBe(true);
        for (const id of result.unassigned) expect(all).not.toContain(id);
    });

    test("decision 19: a table with too few delegates is marked short", () => {
        const result = runRoundtableGrouping(input({ attendees: delegates(6) }));
        expect(result.groups.flatMap((g) => g.seated)).toHaveLength(6);
        expect(result.groups.every((g) => g.short)).toBe(true);
        // Tables fill evenly, so none is left with a single delegate while another has three.
        const sizes = result.groups.map((g) => g.seated.length);
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    });

    test("groups delegates who share answers, and explains what each table has in common", () => {
        const people = [
            ...["a1", "a2", "a3"].map((id) => delegate(id, {}, { meetingInterests: ["Leadership Development"], systemsAndPlatforms: ["Workday"] })),
            ...["b1", "b2", "b3"].map((id) => delegate(id, {}, { meetingInterests: ["Onboarding"], systemsAndPlatforms: ["Go1"] })),
        ];
        const result = runRoundtableGrouping(input({
            attendees: people,
            timeslots: FOUR_TABLES.slice(0, 2),
            settings: { ...SETTINGS, seatsPerTable: 3, alternatesPerTable: 0 },
        }));
        const groups = result.groups.map((g) => g.seated.map((s) => s.delegateId[0]).join(""));
        expect(groups.sort()).toEqual(["aaa", "bbb"]);
        const summaries = result.groups.map((g) => g.summary).sort();
        expect(summaries).toEqual(["Leadership Development (3), Workday (3)", "Onboarding (3), Go1 (3)"]);
        expect(result.groups.every((g) => !g.weak && g.averageScore > 0)).toBe(true);
        expect(result.groups[0].seated[1].reason).toMatch(/^Both: /);
    });

    test("marks a table weak when its average score is below the minimum", () => {
        const strangers = ["Leadership Development", "Onboarding", "Analytics"].map((x, i) =>
            delegate(`s${i}`, {}, { meetingInterests: [x] }),
        );
        const result = runRoundtableGrouping(input({
            attendees: strangers,
            timeslots: FOUR_TABLES.slice(0, 1),
            settings: { ...SETTINGS, seatsPerTable: 3 },
        }));
        expect(result.groups[0].weak).toBe(true);
        expect(result.groups[0].summary).toBe("Nothing in common yet.");
    });

    test("leaves pushed tables and their delegates alone", () => {
        const result = runRoundtableGrouping(input({
            attendees: delegates(8),
            skipTimeslotIds: new Set(["rt1"]),
            takenIds: new Set(["d1", "d2"]),
        }));
        expect(result.groups.map((g) => g.timeslotId)).toEqual(["rt2", "rt3", "rt4"]);
        expect(result.eligibleIds).not.toContain("d1");
    });

    test("orders tables Day 1 first, then by time and location", () => {
        expect(roundtableSlots([FOUR_TABLES[3], FOUR_TABLES[0], FOUR_TABLES[2], FOUR_TABLES[1]]).map((t) => t.id)).toEqual([
            "rt1",
            "rt2",
            "rt3",
            "rt4",
        ]);
    });
});

describe("checkSeatMove", () => {
    const base = {
        role: "seated" as const,
        seats: 5,
        tableStart: FOUR_TABLES[0].startTime,
        busy: new Set<number>(),
        exclusion: null,
    };

    test("criterion 18: moving a delegate onto a table with someone from their company is refused with a message", () => {
        const mover = delegate("m", { accountId: "acct-1", company: "Acme" });
        const colleague = delegate("c", { accountId: "acct-1", company: "Acme", name: "Cora" });
        const check = checkSeatMove({ ...base, delegate: mover, seated: [colleague, delegate("o")] });
        expect(check.errors).toEqual(["m can't sit here. Cora at this table is also from Acme."]);
    });

    test("refuses a delegate who is busy at the table's time, and a full table", () => {
        const mover = delegate("m");
        const busy = new Set([Date.parse(FOUR_TABLES[0].startTime)]);
        const full = Array.from({ length: 5 }, (_, i) => delegate(`f${i}`));
        expect(checkSeatMove({ ...base, delegate: mover, seated: [], busy }).errors).toEqual([
            "m already has a meeting at this table's time.",
        ]);
        expect(checkSeatMove({ ...base, delegate: mover, seated: full }).errors).toEqual([
            "This table already seats 5. Move someone off it first.",
        ]);
    });

    test("allows an alternate from a seated delegate's company with a warning", () => {
        const mover = delegate("m", { accountId: "acct-1", company: "Acme" });
        const colleague = delegate("c", { accountId: "acct-1", company: "Acme", name: "Cora" });
        const check = checkSeatMove({ ...base, role: "alternate", delegate: mover, seated: [colleague] });
        expect(check.errors).toEqual([]);
        expect(check.warnings).toHaveLength(1);
    });

    test("warns when the delegate no longer qualifies", () => {
        const check = checkSeatMove({ ...base, delegate: delegate("m"), seated: [], exclusion: "has_meetings" });
        expect(check.errors).toEqual([]);
        expect(check.warnings[0]).toMatch(/now has a meeting/);
    });
});

describe("roundtableOrderWarning", () => {
    test("warns when no D2D meetings exist, and says nothing once they do", () => {
        expect(roundtableOrderWarning(0)).toMatch(/No D2D meetings/);
        expect(roundtableOrderWarning(2)).toBeNull();
    });
});

describe("DEFAULT_ROUNDTABLE_DESCRIPTION", () => {
    test("criterion 21a: is the host note from decision 24, word for word", () => {
        expect(DEFAULT_ROUNDTABLE_DESCRIPTION).toBe(
            "The system requires one attendee to be designated as the meeting host in order to create the meeting. However, this is purely a system requirement and does not involve any hosting or moderation responsibilities, as all meetings are unmoderated.",
        );
    });

    test("criterion 21a: every table the engine creates starts with the default host note", () => {
        const result = runRoundtableGrouping(input({ attendees: delegates(30), timeslots: FOUR_TABLES }));
        expect(result.groups).toHaveLength(4);
        expect(result.groups.every((g) => g.description === DEFAULT_ROUNDTABLE_DESCRIPTION)).toBe(true);
    });
});

describe("roundtableHostId", () => {
    test("criterion 19: picks the seated delegate with the lowest Salesforce id, whatever the seat order", () => {
        expect(roundtableHostId(["003C", "003A", "003B"])).toBe("003A");
    });

    test("uses the same comparison as the D2D host rule", () => {
        // Plain string comparison puts upper case before lower case, as `idA < idB` does in d2d.ts.
        expect(roundtableHostId(["003a", "003B"])).toBe("003B");
    });

    test("is null when no one is seated", () => {
        expect(roundtableHostId([])).toBeNull();
    });
});
