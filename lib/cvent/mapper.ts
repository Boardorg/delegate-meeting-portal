import "server-only";
import { cache } from "react";
import {
    getTimeslotsByEvent,
    getLocationsByEvent,
    getAppointmentEvent,
} from "@/lib/cvent/client";
import type { CventAvailableTime, CventLocation } from "@/lib/cvent/types";
import type { Timeslot, Location } from "@/types";

/**
 * Maps Cvent's wire shapes (CventAvailableTime / CventLocation) into the app's
 * unified Timeslot / Location format, and provides loadEventScheduleData() — the
 * single entry point the engine and admin actions use to get an event's
 * availability with ready-made id → object lookup maps.
 */

/**
 * Normalizes a Cvent capacity value into a usable number. Cvent uses -1 for
 * "unlimited" and may omit the field; both become Infinity so callers can treat
 * capacity uniformly.
 *
 * @param {number | undefined} raw - The Cvent capacity (availableAppointments or location capacity).
 * @returns {number} A positive count, or Infinity for unlimited/unspecified.
 */
function normalizeCapacity(raw: number | undefined): number {
    if (raw === undefined || raw < 0) return Infinity;
    return raw;
}

/**
 * Converts Cvent available-times into unified Timeslots, deriving the event day
 * for each from the chronological order of distinct calendar dates (earliest
 * date → Day 1, next → Day 2, and so on).
 *
 * Only DEFINED-type times are mapped. FLEXIBLE-type times let a host pick any
 * time/location on the fly rather than booking into a fixed slot, which
 * doesn't match how createAppointment is called here — pushing into one
 * fails with TIMESLOT_NOT_FOUND. Excluding them keeps the app from ever
 * scheduling into a slot it can't actually push to Cvent.
 *
 * @param {CventAvailableTime[]} times - Raw available-times from the Cvent client.
 * @returns {Timeslot[]} The mapped timeslots.
 */
export function toTimeslots(times: CventAvailableTime[]): Timeslot[] {
    const definedTimes = times.filter((t) => t.type === "DEFINED");

    // ISO date (YYYY-MM-DD) → 1-based day index, in chronological order.
    const dates = [...new Set(definedTimes.map((t) => t.startTime.toISOString().slice(0, 10)))].sort();
    const dayByDate = new Map(dates.map((d, i) => [d, i + 1]));

    return definedTimes.map((t) => {
        const startTime = t.startTime.toISOString();
        return {
            id: t.id,
            // Passes only use days 1 and 2; any later date maps to 3+ and is simply never scheduled.
            day: (dayByDate.get(startTime.slice(0, 10)) ?? 1) as Timeslot["day"],
            startTime,
            endTime: t.endTime.toISOString(),
            capacity: normalizeCapacity(t.availableAppointments),
            locationId: t.location?.id ?? null,
            appointmentTypeId: t.appointmentType.id,
        };
    });
}

/**
 * Converts Cvent locations into unified Locations.
 *
 * @param {CventLocation[]} locations - Raw locations from the Cvent client.
 * @returns {Location[]} The mapped locations.
 */
export function toLocations(locations: CventLocation[]): Location[] {
    return locations.map((l) => ({
        id: l.id,
        name: l.name,
        capacity: normalizeCapacity(l.capacity),
        parentLocationId: l.parentLocation?.id ?? null,
    }));
}

/** Resolved event availability plus id → object lookup maps. */
export type EventScheduleData = {
    timeslots: Timeslot[];
    locations: Location[];
    timeslotById: Map<string, Timeslot>;
    locationById: Map<string, Location>;
    /** The event's real IANA timezone (e.g. "America/New_York"), for display formatting. */
    timezone: string;
};

/**
 * Loads and maps an event's timeslots and locations from Cvent (or mock
 * fixtures when USE_MOCK=true), returning them alongside id-keyed lookup maps.
 * Request-memoized (like getEventAttendees) so multiple read actions in one
 * render share a single Cvent round trip. Memoization intentionally ends with
 * the request — availability/locations/types can change in Cvent at any
 * time, so nothing here may persist across requests, or it'd keep serving
 * stale data after every such change until the server process restarted.
 *
 * @param {string} eventCode - The event to load availability for.
 * @returns {Promise<EventScheduleData>} Timeslots, locations, and their lookup maps.
 */
export const loadEventScheduleData = cache(
    async (eventCode: string): Promise<EventScheduleData> => {
        let times: CventAvailableTime[];
        let locations: CventLocation[];
        let timezone: string;
        try {
            let appointmentEvent: { timezone?: string };
            [times, locations, appointmentEvent] = await Promise.all([
                getTimeslotsByEvent(eventCode),
                getLocationsByEvent(eventCode),
                getAppointmentEvent(eventCode),
            ]);
            // Appointment events should always carry their configured timezone;
            // UTC is a defensive fallback, not an expected case.
            timezone = appointmentEvent.timezone ?? "UTC";
        } catch (err) {
            // The live Cvent integration is stubbed until we have real credentials.
            // When it's unavailable (missing creds, API/auth error), degrade to empty
            // availability instead of crashing every read path that resolves times or
            // locations. Mirrors the pre-integration state where availability was empty
            // with USE_MOCK=false.
            console.warn(
                `loadEventScheduleData: Cvent unavailable for event "${eventCode}"; ` +
                    `returning empty availability. ${err instanceof Error ? err.message : String(err)}`,
            );
            return {
                timeslots: [],
                locations: [],
                timeslotById: new Map(),
                locationById: new Map(),
                timezone: "UTC",
            };
        }

        const timeslots = toTimeslots(times);
        const mappedLocations = toLocations(locations);
        return {
            timeslots,
            locations: mappedLocations,
            timeslotById: new Map(timeslots.map((t) => [t.id, t])),
            locationById: new Map(mappedLocations.map((l) => [l.id, l])),
            timezone,
        };
    },
);
