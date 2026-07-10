import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CventSDK } from "@cvent/sdk";
import {
    locationsPaginatedResponseFromJSON,
    availableTimesPaginatedResponseFromJSON,
} from "@cvent/sdk/models/components";
import type { CventLocation, CventAvailableTime } from "@/lib/cvent/types";

/**
 * Client for the Cvent Appointments API, built on the official `@cvent/sdk`.
 *
 * Two read operations are exposed today:
 *   - getLocationsByEvent → appointments.listLocations
 *   - getTimeslotsByEvent → appointments.listAvailableTimes
 *
 * Both walk the SDK's paginated async-iterator to completion and return the
 * full, flattened result set across all pages.
 *
 * Behavior is gated on USE_MOCK (the same switch the attendee loader uses).
 * When USE_MOCK === "true", both methods return canned JSON from
 * data/mock/cvent/ — parsed through the SDK's own decoders so the shapes (and
 * Date coercion) match the live path exactly. No network or credentials needed.
 *
 * NOTE: We don't have Cvent credentials yet, so the live path is unverified
 * scaffolding pending real access.
 */

// Absolute path to the canned Cvent fixtures used in mock mode.
const MOCK_DIR = path.join(process.cwd(), "data", "mock", "cvent");

/** Returns true when the client should serve canned fixtures instead of calling Cvent. */
function isMock(): boolean {
    return process.env.USE_MOCK === "true";
}

// Maps our internal event codes to their Cvent appointment-event id (the `{id}`
// in /ea/appointment-events/{id}/...). Add an entry per event.
// TODO: replace the placeholder with BMWS's real Cvent appointment-event id.
const CVENT_EVENT_IDS: Record<string, string> = {
    BMWS: "05b5b30f-72c9-4aa1-8d24-1c201ff0a5a4",
};

/**
 * Translates an internal event code to its Cvent appointment-event id.
 * Only used on the live path; mock mode never calls this.
 *
 * @param {string} eventCode - The internal event code (e.g. "BMWS").
 * @returns {string} The Cvent appointment-event id.
 * @throws {Error} When the event code has no mapping.
 */
function eventCodeToCventId(eventCode: string): string {
    const id = CVENT_EVENT_IDS[eventCode];
    if (!id) {
        throw new Error(
            `No Cvent appointment-event id mapped for event code "${eventCode}". ` +
                "Add it to CVENT_EVENT_IDS in lib/cvent/client.ts.",
        );
    }
    return id;
}

// ---------------------------------------------------------------------------
// SDK client (singleton)
// ---------------------------------------------------------------------------

// Cvent's production OAuth2 token endpoint. Used unless overridden via env.
const DEFAULT_TOKEN_URL = "https://api-platform.cvent.com/ea/oauth2/token";

// Lazily-built SDK instance, reused across calls in the same Node process. The
// SDK manages its own OAuth2 token lifecycle internally.
let sdk: CventSDK | null = null;

/**
 * Builds (once) and returns the authenticated CventSDK. Reads OAuth2
 * client-credentials config from the environment and fails loudly if the two
 * required secrets are missing. Not called in mock mode.
 *
 * @returns {CventSDK} The shared SDK instance.
 */
function getClient(): CventSDK {
    if (sdk) return sdk;

    const clientID = process.env.CVENT_CLIENT_ID;
    const clientSecret = process.env.CVENT_CLIENT_SECRET;
    if (!clientID || !clientSecret) {
        throw new Error(
            "Missing Cvent env vars: CVENT_CLIENT_ID, CVENT_CLIENT_SECRET",
        );
    }

    // Optional space/comma-separated scopes. When omitted the SDK falls back to
    // the per-operation scopes it declares for each endpoint.
    const scopes = (process.env.CVENT_SCOPES ?? "")
        .split(/[\s,]+/)
        .filter(Boolean);

    sdk = new CventSDK({
        security: {
            oAuth2ClientCredentials: {
                clientID,
                clientSecret,
                // Required: the client-credentials token exchange. Without an
                // explicit tokenURL the SDK posts the token request to the API
                // base URL instead of the OAuth endpoint, so auth silently fails
                // and calls come back as ResponseValidationError.
                tokenURL: process.env.CVENT_TOKEN_URL ?? DEFAULT_TOKEN_URL,
                ...(scopes.length ? { scopes } : {}),
            },
        },
    });
    return sdk;
}

/**
 * Reads and SDK-parses one of the canned Cvent fixtures from data/mock/cvent/.
 * Routing the raw JSON through the SDK's own `*FromJSON` decoder means mock
 * results are validated and shaped identically to live responses (Dates, etc.).
 *
 * @param {string} file - Fixture file name (e.g. "locations.json").
 * @param {(s: string) => { ok: boolean; value?: { data?: T[] }; error?: unknown }} parse - SDK decoder.
 * @returns {Promise<T[]>} The fixture's `data` array.
 */
async function readMock<T>(
    file: string,
    parse: (jsonString: string) => {
        ok: boolean;
        value?: { data?: T[] };
        error?: unknown;
    },
): Promise<T[]> {
    const raw = await fs.readFile(path.join(MOCK_DIR, file), "utf-8");
    const parsed = parse(raw);
    if (!parsed.ok) {
        throw new Error(
            `Invalid Cvent mock fixture ${file}: ${String(parsed.error)}`,
        );
    }
    return parsed.value?.data ?? [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Lists every bookable location for an event, following pagination to the end.
 *
 * @param {string} eventCode - Internal event code; translated to the Cvent appointment-event id.
 * @returns {Promise<CventLocation[]>} All locations across all pages.
 */
export async function getLocationsByEvent(
    eventCode: string,
): Promise<CventLocation[]> {
    if (isMock()) {
        return readMock<CventLocation>(
            "locations.json",
            locationsPaginatedResponseFromJSON,
        );
    }

    const id = eventCodeToCventId(eventCode);
    const out: CventLocation[] = [];

    // The SDK returns a PageIterator; `for await` walks every page for us.
    const pages = await getClient().appointments.listLocations({ id });
    for await (const page of pages) {
        out.push(...(page.result.data ?? []));
    }
    return out;
}

/**
 * Lists every available appointment time block for an event, following
 * pagination to the end.
 *
 * @param {string} eventCode - Internal event code; translated to the Cvent appointment-event id.
 * @returns {Promise<CventAvailableTime[]>} All available times across all pages.
 */
export async function getTimeslotsByEvent(
    eventCode: string,
): Promise<CventAvailableTime[]> {
    if (isMock()) {
        return readMock<CventAvailableTime>(
            "available-times.json",
            availableTimesPaginatedResponseFromJSON,
        );
    }

    const id = eventCodeToCventId(eventCode);
    const out: CventAvailableTime[] = [];

    const pages = await getClient().appointments.listAvailableTimes({ id });
    for await (const page of pages) {
        out.push(...(page.result.data ?? []));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/** Fields needed to create or update a Cvent appointment for a scheduled meeting. */
export type CventAppointmentInput = {
    /** Appointment title shown in Cvent. */
    subject: string;
    /** Appointment start (UTC). */
    startTime: Date;
    /** Appointment end (UTC). */
    endTime: Date;
    /** Cvent location id. Omitted from the request when null/undefined. */
    locationId?: string | null;
    /** Cvent contact ids of the meeting participants. */
    attendeeContactIds?: string[];
    /** External reference code (we pass our meeting id) for traceability. */
    code?: string;
};

/**
 * Reads the appointment host + type ids required to create appointments in
 * Cvent, throwing a single combined error if either is missing.
 *
 * @returns {{ hostId: string; appointmentTypeId: string }} The validated ids.
 */
function readAppointmentEnv(): { hostId: string; appointmentTypeId: string } {
    const hostId = process.env.CVENT_APPOINTMENT_HOST_ID;
    const appointmentTypeId = process.env.CVENT_APPOINTMENT_TYPE_ID;
    if (!hostId || !appointmentTypeId) {
        throw new Error(
            "Missing Cvent env vars: CVENT_APPOINTMENT_HOST_ID, CVENT_APPOINTMENT_TYPE_ID",
        );
    }
    return { hostId, appointmentTypeId };
}

/** Maps a list of Cvent contact ids into the SDK's `{ id }[]` attendee/host shape. */
function toUuidList(ids: string[]): Array<{ id: string }> {
    return ids.map((id) => ({ id }));
}

/**
 * Creates a Cvent appointment for a scheduled meeting and returns its Cvent
 * appointment id. In mock mode returns a synthetic id without any network call.
 *
 * @param {string} eventCode - Internal event code; translated to the Cvent appointment-event id.
 * @param {CventAppointmentInput} input - The appointment fields.
 * @returns {Promise<string>} The created appointment's Cvent id.
 */
export async function createAppointment(
    eventCode: string,
    input: CventAppointmentInput,
): Promise<string> {
    // Mock mode never hits Cvent; hand back a synthetic appointment id.
    if (isMock()) return `mock-appt-${randomUUID()}`;

    const { hostId, appointmentTypeId } = readAppointmentEnv();
    const id = eventCodeToCventId(eventCode);

    const res = await getClient().appointments.createAppointment({
        id,
        createAppointmentRequest: {
            subject: input.subject,
            startTime: input.startTime,
            endTime: input.endTime,
            hosts: [{ id: hostId }],
            appointmentTypeId,
            ...(input.locationId ? { location: input.locationId } : {}),
            ...(input.attendeeContactIds?.length
                ? { attendees: toUuidList(input.attendeeContactIds) }
                : {}),
            ...(input.code ? { code: input.code } : {}),
        },
    });
    return res.id;
}

/**
 * Updates an existing Cvent appointment (used when a meeting was edited after
 * its last push). Returns the appointment id. In mock mode is a no-op that
 * returns the given apptId.
 *
 * @param {string} eventCode - Internal event code; translated to the Cvent appointment-event id.
 * @param {string} apptId - The existing Cvent appointment id to update.
 * @param {CventAppointmentInput} input - The updated appointment fields.
 * @returns {Promise<string>} The appointment's Cvent id.
 */
export async function updateAppointment(
    eventCode: string,
    apptId: string,
    input: CventAppointmentInput,
): Promise<string> {
    if (isMock()) return apptId;

    const { hostId } = readAppointmentEnv();
    const id = eventCodeToCventId(eventCode);

    const res = await getClient().appointments.updateAppointment({
        id,
        apptId,
        updateAppointmentRequest: {
            id: apptId,
            subject: input.subject,
            startTime: input.startTime,
            endTime: input.endTime,
            hosts: [{ id: hostId }],
            ...(input.locationId ? { location: input.locationId } : {}),
            ...(input.attendeeContactIds?.length
                ? { attendees: toUuidList(input.attendeeContactIds) }
                : {}),
        },
    });
    return res.id;
}
