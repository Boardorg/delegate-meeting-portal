import { describe, test, expect } from "vitest";
import {
    MEETING_KINDS,
    NO_SPONSOR_MAPPING_MESSAGE,
    NO_SPONSOR_SLOTS_MESSAGE,
    appointmentTypeRows,
    checkAppointmentTypeMapping,
    kindForAppointmentType,
    parseAppointmentTypeKinds,
    type AppointmentType,
} from "./meetingKinds";

// The four NALES appointment types, as Cvent names them.
const TYPES: AppointmentType[] = [
    { id: "t-s2d", name: "Sponsor to Delegate Meetings" },
    { id: "t-d2d", name: "Delegate to Delegate Meetings" },
    { id: "t-group", name: "Delegate Group Meetings" },
    { id: "t-lunch", name: "Themed Lunches (Round Tables)" },
];

describe("kindForAppointmentType", () => {
    test("returns the mapped kind for a mapped type", () => {
        expect(
            kindForAppointmentType({ "t-s2d": "sponsor_delegate" }, "t-s2d"),
        ).toBe("sponsor_delegate");
    });

    test("returns ignore for an unmapped type", () => {
        expect(
            kindForAppointmentType({ "t-s2d": "sponsor_delegate" }, "t-group"),
        ).toBe("ignore");
    });

    test("returns ignore when the event has no mapping", () => {
        expect(kindForAppointmentType(null, "t-s2d")).toBe("ignore");
    });
});

describe("appointmentTypeRows", () => {
    test("offers every appointment type Cvent returns, each with all four kinds", () => {
        const rows = appointmentTypeRows(TYPES, { "t-s2d": "sponsor_delegate" });

        expect(rows.map((r) => r.name)).toEqual(TYPES.map((t) => t.name));
        for (const row of rows) {
            expect([...row.options]).toEqual([
                "sponsor_delegate",
                "delegate_delegate",
                "delegate_group",
                "ignore",
            ]);
        }
    });

    test("shows the saved kind, and blank for unmapped types", () => {
        const rows = appointmentTypeRows(TYPES, { "t-s2d": "sponsor_delegate" });

        expect(rows.map((r) => r.kind)).toEqual(["sponsor_delegate", "", "", ""]);
    });
});

describe("parseAppointmentTypeKinds", () => {
    test("accepts a mapping with only sponsor_delegate set", () => {
        expect(parseAppointmentTypeKinds({ "t-s2d": "sponsor_delegate" })).toEqual({
            ok: true,
            kinds: { "t-s2d": "sponsor_delegate" },
        });
    });

    test("accepts every allowed kind", () => {
        const all = Object.fromEntries(MEETING_KINDS.map((k, i) => [`t-${i}`, k]));
        expect(parseAppointmentTypeKinds(all)).toEqual({ ok: true, kinds: all });
    });

    test("rejects an unknown kind value", () => {
        const result = parseAppointmentTypeKinds({ "t-s2d": "sponsor_sponsor" });

        expect(result.ok).toBe(false);
        expect(!result.ok && result.error).toContain("sponsor_sponsor");
    });

    test("rejects a value that is not an object", () => {
        expect(parseAppointmentTypeKinds(["sponsor_delegate"]).ok).toBe(false);
        expect(parseAppointmentTypeKinds("sponsor_delegate").ok).toBe(false);
    });

    test("stores an empty mapping as null", () => {
        expect(parseAppointmentTypeKinds({})).toEqual({ ok: true, kinds: null });
    });
});

describe("checkAppointmentTypeMapping", () => {
    // One loaded sponsor slot, as the mapper tags it when t-s2d is mapped.
    const SPONSOR_SLOT = [{ appointmentTypeId: "t-s2d", kind: "sponsor_delegate" as const }];

    test("stops when no type is mapped to sponsor_delegate", () => {
        expect(
            checkAppointmentTypeMapping(TYPES, { "t-d2d": "delegate_delegate" }, []),
        ).toEqual({ ok: false, message: NO_SPONSOR_MAPPING_MESSAGE });
        expect(checkAppointmentTypeMapping(TYPES, null, []).ok).toBe(false);
    });

    test("stops when sponsor_delegate is mapped to an id no loaded slot has", () => {
        // A stale mapping, for example saved against another Cvent event.
        const result = checkAppointmentTypeMapping(
            TYPES,
            { "t-old-event": "sponsor_delegate" },
            [{ appointmentTypeId: "t-s2d", kind: "ignore" }],
        );
        expect(result).toEqual({ ok: false, message: NO_SPONSOR_SLOTS_MESSAGE });
    });

    test("stops when no timeslots were loaded", () => {
        expect(
            checkAppointmentTypeMapping(TYPES, { "t-s2d": "sponsor_delegate" }, []),
        ).toEqual({ ok: false, message: NO_SPONSOR_SLOTS_MESSAGE });
    });

    test("goes ahead and names each unmapped type", () => {
        expect(
            checkAppointmentTypeMapping(TYPES, { "t-s2d": "sponsor_delegate" }, SPONSOR_SLOT),
        ).toEqual({
            ok: true,
            unmappedTypeNames: [
                "Delegate to Delegate Meetings",
                "Delegate Group Meetings",
                "Themed Lunches (Round Tables)",
            ],
        });
    });

    test("treats a type set to ignore as mapped", () => {
        const result = checkAppointmentTypeMapping(TYPES, {
            "t-s2d": "sponsor_delegate",
            "t-d2d": "ignore",
            "t-group": "ignore",
            "t-lunch": "ignore",
        }, SPONSOR_SLOT);
        expect(result).toEqual({ ok: true, unmappedTypeNames: [] });
    });

    test("names a slot type Cvent didn't list by its id", () => {
        const result = checkAppointmentTypeMapping(
            [],
            { "t-s2d": "sponsor_delegate" },
            [...SPONSOR_SLOT, { appointmentTypeId: "t-mystery", kind: "ignore" }],
        );
        expect(result).toEqual({ ok: true, unmappedTypeNames: ["t-mystery"] });
    });
});
