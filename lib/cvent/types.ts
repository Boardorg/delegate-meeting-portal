/**
 * Cvent Appointments API types.
 *
 * These are re-exported straight from the official `@cvent/sdk` so we have a
 * single source of truth for Cvent's wire shapes and stay in sync with the SDK
 * version. The friendly aliases (`CventLocation`, `CventAvailableTime`) are
 * what the rest of the app imports, so consumers don't depend on the SDK's
 * `*Json` naming or its internal module paths.
 *
 * Item shapes (note: the SDK parses `startTime`/`endTime` into `Date` objects):
 *   - CventLocation:      id, name, parentLocation?, capacity?
 *   - CventAvailableTime: id, startTime, endTime, type, appointmentType, location?, availableAppointments?
 */
export type {
    LocationJson as CventLocation,
    AvailableTimeJson as CventAvailableTime,
    LocationsPaginatedResponse,
    AvailableTimesPaginatedResponse,
} from "@cvent/sdk/models/components";
