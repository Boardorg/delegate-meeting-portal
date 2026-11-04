import { describe, test, expect } from "vitest";
import type { CventAvailableTime } from "@/lib/cvent/types";
import { toTimeslots } from "./mapper";

/**
 * Builds a minimal Cvent available-time for mapper tests.
 *
 * @param {string} id - The available-time id.
 * @param {string} start - ISO start time.
 * @param {string} appointmentTypeId - The Cvent appointment-type id.
 * @returns {CventAvailableTime} The available-time.
 */
function time(id: string, start: string, appointmentTypeId: string): CventAvailableTime {
    return {
        id,
        startTime: new Date(start),
        endTime: new Date(start),
        type: "DEFINED",
        appointmentType: { id: appointmentTypeId },
        location: { id: "loc-1" },
        availableAppointments: 2,
    } as CventAvailableTime;
}

const TIMES = [
    time("a", "2026-01-20T10:00:00Z", "t-s2d"),
    time("b", "2026-01-20T11:00:00Z", "t-group"),
    time("c", "2026-01-21T10:00:00Z", "t-s2d"),
];

describe("toTimeslots — meeting kinds", () => {
    test("gives a slot mapped to sponsor_delegate that kind, and an unmapped one ignore", () => {
        const slots = toTimeslots(TIMES, { "t-s2d": "sponsor_delegate" });

        expect(slots.map((s) => [s.id, s.kind])).toEqual([
            ["a", "sponsor_delegate"],
            ["b", "ignore"],
            ["c", "sponsor_delegate"],
        ]);
    });

    test("marks every slot ignore when the event has no mapping", () => {
        const slots = toTimeslots(TIMES);

        expect(slots.every((s) => s.kind === "ignore")).toBe(true);
    });

    test("keeps the day from date order", () => {
        const slots = toTimeslots(TIMES, { "t-s2d": "sponsor_delegate" });

        expect(slots.map((s) => s.day)).toEqual([1, 1, 2]);
    });

    test("names each slot's appointment type when Cvent listed it", () => {
        const slots = toTimeslots(TIMES, null, [
            { id: "t-s2d", name: "Sponsor to Delegate Meetings" },
        ]);

        expect(slots.map((s) => s.appointmentTypeName)).toEqual([
            "Sponsor to Delegate Meetings",
            null,
            "Sponsor to Delegate Meetings",
        ]);
    });
});
