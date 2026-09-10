import { describe, test, expect } from "vitest";
import { buildCreateAppointmentRequest, toExistingAppointments } from "./client";

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
