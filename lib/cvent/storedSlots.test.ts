import { describe, test, expect } from "vitest";
import type { Location, Timeslot } from "@/types";
import type { CventExistingAppointment } from "@/lib/cvent/client";
import { missingSlotMessage, storedSlotMap, type SlotSources } from "./storedSlots";

// ---------------------------------------------------------------------------
// Rebuilding a stored row's slot from its Cvent appointment.
// Cvent's available-times list only lists free times, so a booked time at a
// location that allows one appointment at a time drops out of it.
// ---------------------------------------------------------------------------

/**
 * Builds a listed timeslot.
 *
 * @param {string} id - The timeslot id.
 * @param {string} startTime - The ISO start time.
 * @param {1 | 2} day - The event day.
 * @param {string} [locationId] - The location. Defaults to "loc-b".
 * @returns {Timeslot} The slot.
 */
function slot(id: string, startTime: string, day: 1 | 2, locationId = "loc-b"): Timeslot {
    return {
        id,
        day,
        startTime,
        endTime: new Date(new Date(startTime).getTime() + 20 * 60000).toISOString(),
        capacity: 1,
        locationId,
        appointmentTypeId: "type-g",
        appointmentTypeName: "Delegate Group Meetings",
        kind: "delegate_group",
    };
}

/**
 * Builds the BMWS-style schedule data: Table B only lists 14:55 and 15:20, since 14:30 is booked.
 *
 * @returns {SlotSources} The schedule data.
 */
function sources(): SlotSources {
    const timeslots = [
        slot("ts-1455", "2026-10-31T14:55:00.000Z", 1),
        slot("ts-1520", "2026-10-31T15:20:00.000Z", 1),
        slot("ts-day2", "2026-11-01T09:00:00.000Z", 2, "loc-c"),
    ];
    const locations: Location[] = [
        { id: "loc-b", name: "D2D Table B", capacity: 1, parentLocationId: null },
        { id: "loc-c", name: "D2D Table C", capacity: 1, parentLocationId: null },
    ];
    return {
        timeslots,
        timeslotById: new Map(timeslots.map((t) => [t.id, t])),
        locations,
        appointmentTypes: [{ id: "type-g", name: "Delegate Group Meetings" }],
        appointmentTypeKinds: { "type-g": "delegate_group" },
    };
}

/**
 * Builds an active Cvent appointment as getEventAppointments returns it, with names but no ids.
 *
 * @param {Partial<CventExistingAppointment>} [overrides] - Fields to change.
 * @returns {CventExistingAppointment} The appointment.
 */
function appointment(overrides: Partial<CventExistingAppointment> = {}): CventExistingAppointment {
    return {
        id: "appt-b",
        startTime: "2026-10-31T14:30:00.000Z",
        endTime: "2026-10-31T14:50:00.000Z",
        participantContactIds: ["c-1"],
        hostContactIds: ["c-1"],
        locationName: "D2D Table B",
        locationId: null,
        typeName: "Delegate Group Meetings",
        typeId: null,
        ...overrides,
    };
}

describe("storedSlotMap", () => {
    test("rebuilds a pushed row's unlisted slot from its Cvent appointment, under the stored id", () => {
        const map = storedSlotMap(
            sources(),
            [{ timeslotId: "ts-1430", cventAppointmentId: "appt-b", locationId: "loc-b" }],
            [appointment()],
        );

        expect(map.get("ts-1430")).toEqual({
            id: "ts-1430",
            day: 1,
            startTime: "2026-10-31T14:30:00.000Z",
            endTime: "2026-10-31T14:50:00.000Z",
            capacity: 1,
            locationId: "loc-b",
            appointmentTypeId: "type-g",
            appointmentTypeName: "Delegate Group Meetings",
            kind: "delegate_group",
        });
        // The listed slots are all still there.
        expect(map.get("ts-1455")?.startTime).toBe("2026-10-31T14:55:00.000Z");
    });

    test("keeps a listed slot as listed, even when the row has an appointment", () => {
        const map = storedSlotMap(
            sources(),
            [{ timeslotId: "ts-1455", cventAppointmentId: "appt-b", locationId: "loc-b" }],
            [appointment()],
        );

        expect(map.get("ts-1455")?.startTime).toBe("2026-10-31T14:55:00.000Z");
    });

    test("reads the location from the appointment's name when the row has none", () => {
        const map = storedSlotMap(
            sources(),
            [{ timeslotId: "ts-1430", cventAppointmentId: "appt-b", locationId: null }],
            [appointment()],
        );

        expect(map.get("ts-1430")?.locationId).toBe("loc-b");
    });

    test("takes the type from a listed slot at the same location when Cvent doesn't name it", () => {
        const map = storedSlotMap(
            sources(),
            [{ timeslotId: "ts-1430", cventAppointmentId: "appt-b", locationId: "loc-b" }],
            [appointment({ typeName: null })],
        );

        expect(map.get("ts-1430")).toMatchObject({
            appointmentTypeId: "type-g",
            appointmentTypeName: "Delegate Group Meetings",
            kind: "delegate_group",
        });
    });

    test("prefers the ids on a raw record", () => {
        const s = sources();
        s.appointmentTypes.push({ id: "type-x", name: "Other" });
        const map = storedSlotMap(
            { ...s, appointmentTypeKinds: { "type-g": "delegate_group", "type-x": "delegate_delegate" } },
            [{ timeslotId: "ts-1430", cventAppointmentId: "appt-b", locationId: null }],
            [appointment({ typeId: "type-x", typeName: "Other", locationId: "loc-c" })],
        );

        expect(map.get("ts-1430")).toMatchObject({ locationId: "loc-c", appointmentTypeId: "type-x", kind: "delegate_delegate" });
    });

    test("numbers the day by date, like the listed slots", () => {
        const map = storedSlotMap(
            sources(),
            [{ timeslotId: "ts-old", cventAppointmentId: "appt-d2", locationId: "loc-c" }],
            [appointment({ id: "appt-d2", startTime: "2026-11-01T08:00:00.000Z", endTime: "2026-11-01T08:20:00.000Z" })],
        );

        expect(map.get("ts-old")?.day).toBe(2);
    });

    test("leaves a slot missing when the row has no appointment, or its appointment isn't active", () => {
        const map = storedSlotMap(
            sources(),
            [
                { timeslotId: "ts-gone", cventAppointmentId: null, locationId: "loc-b" },
                { timeslotId: "ts-cancelled", cventAppointmentId: "appt-cancelled", locationId: "loc-b" },
            ],
            [appointment()],
        );

        expect(map.has("ts-gone")).toBe(false);
        expect(map.has("ts-cancelled")).toBe(false);
    });

    test("leaves a slot missing when Cvent's appointment list couldn't be read", () => {
        const map = storedSlotMap(
            sources(),
            [{ timeslotId: "ts-1430", cventAppointmentId: "appt-b", locationId: "loc-b" }],
            null,
        );

        expect(map.has("ts-1430")).toBe(false);
    });
});

describe("missingSlotMessage", () => {
    test("tells an admin what to do for a roundtable and for a meeting", () => {
        expect(missingSlotMessage("roundtable", "ts-1")).toContain("Unpush it and run grouping again.");
        expect(missingSlotMessage("meeting", "ts-1")).toContain("Move it to another slot.");
    });
});
