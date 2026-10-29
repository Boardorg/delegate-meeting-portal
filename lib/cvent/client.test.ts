import { describe, test, expect, vi } from "vitest";
import {
    buildCreateAppointmentRequest,
    buildUpdateAppointmentRequest,
    getAppointmentTypes,
    getTimeslotsByEvent,
    toAppointmentsPage,
    toAppointmentTypes,
    toAppointmentTypesPage,
    toExistingAppointments,
} from "./client";

// ---------------------------------------------------------------------------
// Cvent payload shaping (multi-host) + existing-appointment reader.
// ---------------------------------------------------------------------------

describe("buildCreateAppointmentRequest", () => {
    const base = {
        subject: "Acme & Globex",
        startTime: new Date("2025-01-15T09:00:00Z"),
        endTime: new Date("2025-01-15T09:30:00Z"),
        appointmentTypeId: "type-1",
    };

    test("puts every host contact id in hosts[] and the delegate in attendees[]", () => {
        const req = buildCreateAppointmentRequest({
            ...base,
            hostContactIds: ["h1", "h2", "h3"],
            attendeeContactIds: ["d1"],
            locationId: "loc-1",
            code: "mtg-1",
        });
        expect(req.hosts).toEqual([{ id: "h1" }, { id: "h2" }, { id: "h3" }]);
        expect(req.attendees).toEqual([{ id: "d1" }]);
        expect(req.location).toBe("loc-1");
        expect(req.code).toBe("mtg-1");
    });

    test("omits attendees, location and code when not provided", () => {
        const req = buildCreateAppointmentRequest({
            ...base,
            hostContactIds: ["h1"],
        });
        expect(req.hosts).toEqual([{ id: "h1" }]);
        expect("attendees" in req).toBe(false);
        expect("location" in req).toBe(false);
        expect("code" in req).toBe(false);
    });
});

describe("buildUpdateAppointmentRequest", () => {
    test("carries the new location and participants, minus the create-only fields", () => {
        const req = buildUpdateAppointmentRequest("appt-1", {
            subject: "Acme & Globex",
            startTime: new Date("2025-01-15T09:00:00Z"),
            endTime: new Date("2025-01-15T09:30:00Z"),
            appointmentTypeId: "type-1",
            hostContactIds: ["h1", "h2"],
            attendeeContactIds: ["d1"],
            locationId: "loc-2",
            code: "mtg-1",
        });
        expect(req.id).toBe("appt-1");
        expect(req.location).toBe("loc-2");
        expect(req.hosts).toEqual([{ id: "h1" }, { id: "h2" }]);
        expect(req.attendees).toEqual([{ id: "d1" }]);
        // Cvent's update endpoint doesn't accept these.
        expect("appointmentTypeId" in req).toBe(false);
        expect("autoAccept" in req).toBe(false);
        expect("code" in req).toBe(false);
    });
});

describe("toExistingAppointments", () => {
    test("captures all hosts + the attendee, skipping cancelled and deleted", () => {
        const out = toExistingAppointments([
            {
                start: "2025-01-15T09:00:00Z",
                status: "ACTIVE",
                participants: [
                    { type: "host", attendee: { contact: { id: "h1" } } },
                    { type: "host", attendee: { contact: { id: "h2" } } },
                    { type: "attendee", attendee: { contact: { id: "d1" } } },
                ],
            },
            {
                start: "2025-01-15T10:00:00Z",
                status: "CANCELLED",
                participants: [
                    { type: "attendee", attendee: { contact: { id: "x" } } },
                ],
            },
            {
                start: "2025-01-15T11:00:00Z",
                deleted: true,
                participants: [
                    { type: "attendee", attendee: { contact: { id: "y" } } },
                ],
            },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].startTime).toBe("2025-01-15T09:00:00Z");
        expect(out[0].participantContactIds).toEqual(["h1", "h2", "d1"]);
    });

    test("falls back to attendee.id when a host has no nested contact", () => {
        const out = toExistingAppointments([
            {
                start: "2025-01-15T09:00:00Z",
                status: "ACTIVE",
                participants: [
                    { type: "host", attendee: { id: "reg-only" } },
                    { type: "attendee", attendee: { contact: { id: "d1" } } },
                ],
            },
        ]);
        expect(out[0].participantContactIds).toEqual(["reg-only", "d1"]);
    });
});

describe("toAppointmentsPage — appointment type", () => {
    test("reads the type name Cvent lists, as { name } only", () => {
        const page = toAppointmentsPage({
            data: [
                {
                    id: "1da91f20-8f37-4f23-91d8-574406e1c8bf",
                    start: "2026-01-20T10:00:00Z",
                    end: "2026-01-20T10:20:00Z",
                    type: { name: " Delegate Group Meetings " },
                },
            ],
            paging: { nextToken: "next-1" },
        });
        expect(page.data[0].typeName).toBe("Delegate Group Meetings");
        expect(page.nextToken).toBe("next-1");
    });

    test("gives null when an appointment has no type name", () => {
        const page = toAppointmentsPage({
            data: [
                { id: "a", start: "2026-01-20T10:00:00Z", end: "2026-01-20T10:20:00Z" },
                { id: "b", start: "2026-01-20T10:00:00Z", end: "2026-01-20T10:20:00Z", type: { name: "" } },
            ],
        });
        expect(page.data.map((a) => a.typeName)).toEqual([null, null]);
    });
});

describe("toAppointmentTypes", () => {
    test("keeps id and name, and drops records with no id", () => {
        expect(
            toAppointmentTypes([
                { id: "t-1", name: "Sponsor to Delegate Meetings" },
                { name: "No id" },
            ]),
        ).toEqual([{ id: "t-1", name: "Sponsor to Delegate Meetings" }]);
    });

    test("falls back to the id when a type has no name", () => {
        expect(toAppointmentTypes([{ id: "t-1", name: " " }])).toEqual([
            { id: "t-1", name: "t-1" },
        ]);
    });
});

describe("toAppointmentTypesPage", () => {
    test("reads a raw body that failed SDK validation, including the next token", () => {
        // Cvent can omit fields the SDK requires, such as category.
        const page = toAppointmentTypesPage({
            data: [{ id: "t-1", name: "Delegate Group Meetings" }],
            paging: { nextToken: "next-1" },
        });
        expect(page).toEqual({
            data: [{ id: "t-1", name: "Delegate Group Meetings" }],
            nextToken: "next-1",
        });
    });
});

describe("getAppointmentTypes — mock mode", () => {
    test("reads the four NALES-style types from the fixture", async () => {
        vi.stubEnv("USE_MOCK", "true");
        try {
            const types = await getAppointmentTypes("MOCK");
            expect(types.map((t) => t.name)).toEqual([
                "Sponsor to Delegate Meetings",
                "Delegate Group Meetings",
                "Delegate to Delegate Meetings",
                "Themed Lunches (Round Tables)",
            ]);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    test("the timeslot fixture has sponsor slots on both days", async () => {
        vi.stubEnv("USE_MOCK", "true");
        try {
            const [types, times] = await Promise.all([
                getAppointmentTypes("MOCK"),
                getTimeslotsByEvent("MOCK"),
            ]);
            const sponsorType = types.find(
                (t) => t.name === "Sponsor to Delegate Meetings",
            );
            const sponsorDates = new Set(
                times
                    .filter((t) => t.appointmentType.id === sponsorType?.id)
                    .map((t) => t.startTime.toISOString().slice(0, 10)),
            );
            expect(sponsorDates.size).toBe(2);
        } finally {
            vi.unstubAllEnvs();
        }
    });
});
