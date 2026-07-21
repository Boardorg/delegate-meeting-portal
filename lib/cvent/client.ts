import "server-only";
import { cache } from "react";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CventSDK } from "@cvent/sdk";
import {
    locationsPaginatedResponseFromJSON,
    availableTimesPaginatedResponseFromJSON,
    attendeePaginatedResponseFromJSON,
    appointmentEventFromJSON,
} from "@cvent/sdk/models/components";
import type {
    CventLocation,
    CventAvailableTime,
    CventAppointmentEvent,
} from "@/lib/cvent/types";
import { getEventSettings } from "@/lib/events/settings";

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

/**
 * Loads an event's settings row (managed in /admin/event-settings), throwing a
 * clear error if the event has no configuration row. Only used on the live
 * path; mock mode never calls this.
 *
 * @param {string} eventCode - The internal event code (e.g. "BMWS").
 * @returns {Promise<import("@/lib/db/schema").EventSettingsRow>} The settings row.
 * @throws {Error} When the event has no settings row.
 */
async function requireEventSettings(eventCode: string) {
    const settings = await getEventSettings(eventCode);
    if (!settings) {
        throw new Error(
            `No Cvent settings configured for event "${eventCode}". ` +
                "Add them in Admin → Event settings.",
        );
    }
    return settings;
}

/**
 * Resolves an event's Cvent appointment-event id (the `{id}` in
 * /ea/appointment-events/{id}/...) from its settings row.
 *
 * @param {string} eventCode - The internal event code.
 * @returns {Promise<string>} The Cvent appointment-event id.
 * @throws {Error} When the event has no settings row or no appointment-event id.
 */
async function getAppointmentEventId(eventCode: string): Promise<string> {
    const { cventAppointmentEventId } = await requireEventSettings(eventCode);
    if (!cventAppointmentEventId) {
        throw new Error(
            `Event "${eventCode}" has no Cvent Appointment Event ID set ` +
                "(Admin → Event settings).",
        );
    }
    return cventAppointmentEventId;
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
                // and calls come back as ResponseValidationError. `||` (not `??`)
                // so an empty-but-present env var falls back too — the SDK treats
                // an empty tokenURL as "credentials incomplete" and silently drops
                // the Authorization header on every call.
                tokenURL: process.env.CVENT_TOKEN_URL || DEFAULT_TOKEN_URL,
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

    const id = await getAppointmentEventId(eventCode);
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

    const id = await getAppointmentEventId(eventCode);
    const out: CventAvailableTime[] = [];

    const pages = await getClient().appointments.listAvailableTimes({ id });
    for await (const page of pages) {
        out.push(...(page.result.data ?? []));
    }
    return out;
}

/** Minimal appointment fields needed to resolve a synced meeting's display time and location. */
export type CventAppointmentSummary = {
    id: string;
    startTime: Date;
    endTime: Date;
    locationName: string | null;
};

/** One page of raw listAppointments data, reduced to what we need plus the next page token. */
type AppointmentsPage = { data: CventAppointmentSummary[]; nextToken?: string };

/**
 * Parses a raw listAppointments response body (as delivered by Cvent, before
 * any SDK validation) into one page's worth of appointment summaries. Shared
 * by the success path and the validation-error recovery path in
 * getAppointmentsByEvent, since both need to read the same wire shape.
 *
 * @param {unknown} parsed - The JSON-parsed response body.
 * @returns {AppointmentsPage} The page's appointments and next token, if any.
 */
function toAppointmentsPage(parsed: unknown): AppointmentsPage {
    const body = parsed as {
        data?: Array<{
            id: string;
            start: string | Date;
            end: string | Date;
            location?: { name?: string };
        }>;
        paging?: { nextToken?: string };
    };
    return {
        data: (body.data ?? []).map((a) => ({
            id: a.id,
            startTime: new Date(a.start),
            endTime: new Date(a.end),
            locationName: a.location?.name ?? null,
        })),
        nextToken: body.paging?.nextToken,
    };
}

/**
 * Fetches one page of an event's appointments for a given pagination token.
 * Driven manually (an explicit token per call) rather than through the SDK's
 * own for-await pagination helper: that helper's generator throws and dies on
 * the first page whose validation fails, which loses every later page too.
 * Calling the operation directly per page keeps each page independent, so a
 * validation failure on one page doesn't stop us from still fetching the next.
 *
 * @param {string} id - The Cvent appointment-event id.
 * @param {string | undefined} token - The page token, or undefined for the first page.
 * @returns {Promise<AppointmentsPage>} That page's appointments and next token, if any.
 */
async function fetchAppointmentsPage(
    id: string,
    token: string | undefined,
): Promise<AppointmentsPage> {
    try {
        const page = await getClient().appointments.listAppointments({
            filter: `appointmentEvent.id eq '${id}'`,
            ...(token ? { token } : {}),
        });
        return {
            data: (page.result.data ?? []).map((a) => ({
                id: a.id,
                startTime: a.start,
                endTime: a.end,
                locationName: a.location?.name ?? null,
            })),
            nextToken: page.result.paging.nextToken,
        };
    } catch (err) {
        const body = recoverableResponseBody(err);
        if (body) {
            try {
                return toAppointmentsPage(JSON.parse(body));
            } catch {
                // Body wasn't parseable JSON — fall through and re-throw.
            }
        }
        throw err;
    }
}

/**
 * Lists every appointment for an event, following pagination to the end.
 * Used to resolve a synced meeting's display time and location from the
 * appointment itself, since listAvailableTimes/listLocations only reflect
 * currently open capacity and stop including a slot once it's fully booked.
 *
 * @param {string} eventCode - Internal event code; translated to the Cvent appointment-event id.
 * @returns {Promise<CventAppointmentSummary[]>} All appointments across all pages.
 */
export async function getAppointmentsByEvent(
    eventCode: string,
): Promise<CventAppointmentSummary[]> {
    if (isMock()) return [];

    const id = await getAppointmentEventId(eventCode);
    const out: CventAppointmentSummary[] = [];
    let token: string | undefined;

    do {
        const page = await fetchAppointmentsPage(id, token);
        out.push(...page.data);
        token = page.nextToken;
    } while (token);

    return out;
}

/**
 * Fetches an event's Cvent appointment-event record, which carries the IANA
 * `timezone` its appointment times are scheduled against. Needed for display:
 * Cvent's timeslot timestamps are genuine UTC, and converting them to the
 * viewer's local time (rather than a hardcoded zone) requires knowing this.
 * Request-memoized like getEventAttendees.
 *
 * @param {string} eventCode - Internal event code; translated to the Cvent appointment-event id.
 * @returns {Promise<CventAppointmentEvent>} The appointment-event record.
 */
export const getAppointmentEvent = cache(
    async (eventCode: string): Promise<CventAppointmentEvent> => {
        if (isMock()) {
            const raw = await fs.readFile(
                path.join(MOCK_DIR, "appointment-event.json"),
                "utf-8",
            );
            const parsed = appointmentEventFromJSON(raw);
            if (!parsed.ok || !parsed.value) {
                throw new Error(
                    `Invalid Cvent mock fixture appointment-event.json: ${String(parsed.error)}`,
                );
            }
            return parsed.value;
        }

        const id = await getAppointmentEventId(eventCode);
        return getClient().appointments.getAppointmentEventById({ id });
    },
);

/** One Cvent attendee, reduced to what the cross-check needs. */
export type CventEventAttendee = {
    /** Cvent contact id — used as the appointment host/attendee id. */
    contactId: string;
    /** Contact email — the key used to match against Salesforce attendees. */
    email: string;
};

/**
 * Reduces raw Cvent attendee records to `{ contactId, email }`, dropping any
 * record missing either field (both are required to match + push).
 */
function toCventEventAttendees(
    data: Array<{ contact?: { id?: string; email?: string } }>,
): CventEventAttendee[] {
    const out: CventEventAttendee[] = [];
    for (const a of data) {
        const contactId = a.contact?.id;
        const email = a.contact?.email;
        if (contactId && email) out.push({ contactId, email });
    }
    return out;
}

/**
 * Lists the event's Cvent attendees (contact id + email), following pagination
 * to the end. Used by loadAttendees to cross-check Salesforce attendees against
 * Cvent by email. Request-memoized so repeated attendee loads in one render
 * share the fetch.
 *
 * @param {string} eventCode - Internal event code; resolved to the event's Cvent Event ID.
 * @returns {Promise<CventEventAttendee[]>} All Cvent attendees for the event.
 * @throws {Error} When the event has no Cvent Event ID configured.
 */
export const getEventAttendees = cache(
    async (eventCode: string): Promise<CventEventAttendee[]> => {
        if (isMock()) {
            const raw = await fs.readFile(
                path.join(MOCK_DIR, "attendees.json"),
                "utf-8",
            );
            const parsed = attendeePaginatedResponseFromJSON(raw);
            if (!parsed.ok) {
                throw new Error(
                    `Invalid Cvent mock fixture attendees.json: ${String(parsed.error)}`,
                );
            }
            return toCventEventAttendees(parsed.value?.data ?? []);
        }

        const { cventEventId } = await requireEventSettings(eventCode);
        if (!cventEventId) {
            throw new Error(
                `Event "${eventCode}" has no Cvent Event ID set (Admin → Event settings).`,
            );
        }

        const out: CventEventAttendee[] = [];
        const pages = await getClient().attendees.listAttendees({
            filter: `event.id eq '${cventEventId}'`,
        });
        for await (const page of pages) {
            out.push(...toCventEventAttendees(page.result.data ?? []));
        }
        return out;
    },
);

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
    /** Cvent contact id of the appointment host (the meeting's requester). */
    hostContactId: string;
    /** Cvent appointment-type id, taken from the booked timeslot. Required on create; Cvent's update endpoint doesn't accept it. */
    appointmentTypeId: string;
    /** Cvent location id. Omitted from the request when null/undefined. */
    locationId?: string | null;
    /** Cvent contact ids of the appointment attendees (the non-host participant). */
    attendeeContactIds?: string[];
    /** External reference code (we pass our meeting id) for traceability. */
    code?: string;
};

/** Maps a list of Cvent contact ids into the SDK's `{ id }[]` attendee/host shape. */
function toUuidList(ids: string[]): Array<{ id: string }> {
    return ids.map((id) => ({ id }));
}

/**
 * Whether to suppress Cvent notifications (invite/update emails) when pushing
 * appointments. Controlled by CVENT_SUPPRESS_NOTIFICATIONS; defaults to false
 * (notifications sent as configured in Cvent).
 */
function suppressNotifications(): boolean {
    return process.env.CVENT_SUPPRESS_NOTIFICATIONS === "true";
}

/**
 * Cvent's appointment responses (create, update, list) can all omit fields
 * their response schema marks required (e.g. `type`), so the SDK throws
 * ResponseValidationError even when the call actually succeeded (HTTP 2xx
 * with a valid body). Returns the raw response body text when the thrown
 * error looks like exactly that case, so callers can parse out whatever
 * fields they need themselves instead of losing a real success to a
 * response-shape mismatch. Returns null for anything else (a genuine error),
 * which callers should re-throw.
 *
 * @param {unknown} err - The error thrown by an SDK call.
 * @returns {string | null} The raw 2xx response body, or null if err isn't a recoverable validation error.
 */
function recoverableResponseBody(err: unknown): string | null {
    const e = err as { statusCode?: number; body?: string };
    if (
        typeof e.statusCode === "number" &&
        e.statusCode >= 200 &&
        e.statusCode < 300 &&
        typeof e.body === "string"
    ) {
        return e.body;
    }
    return null;
}

/**
 * Recovers a created/updated appointment id from a thrown SDK error — see
 * recoverableResponseBody for why this can happen on a real success. Anything
 * that isn't a recoverable 2xx-with-id is re-thrown.
 *
 * @param {unknown} err - The error thrown by the SDK call.
 * @returns {string} The appointment id parsed from the successful response body.
 * @throws {unknown} The original error when it isn't a recoverable 2xx response.
 */
function recoverAppointmentId(err: unknown): string {
    const body = recoverableResponseBody(err);
    if (body) {
        try {
            const parsed = JSON.parse(body) as { id?: unknown };
            if (typeof parsed.id === "string" && parsed.id) return parsed.id;
        } catch {
            // Body wasn't JSON with an id — fall through and re-throw.
        }
    }
    throw err;
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

    const id = await getAppointmentEventId(eventCode);

    try {
        const res = await getClient().appointments.createAppointment({
            id,
            suppressNotifications: suppressNotifications(),
            createAppointmentRequest: {
                subject: input.subject,
                startTime: input.startTime,
                endTime: input.endTime,
                hosts: [{ id: input.hostContactId }],
                appointmentTypeId: input.appointmentTypeId,
                ...(input.locationId ? { location: input.locationId } : {}),
                ...(input.attendeeContactIds?.length
                    ? { attendees: toUuidList(input.attendeeContactIds) }
                    : {}),
                ...(input.code ? { code: input.code } : {}),
            },
        });
        return res.id;
    } catch (err) {
        // Treat an over-strict response-validation failure on a real 2xx as success.
        return recoverAppointmentId(err);
    }
}

/**
 * Cancels an existing Cvent appointment (used when a pushed portal meeting is
 * deleted, so the Cvent side doesn't end up with an orphaned appointment). In
 * mock mode is a no-op.
 *
 * Note: cancelling does not free the appointment's `code` for reuse — Cvent
 * keeps it reserved even after cancellation, so callers must mint a fresh
 * code rather than reusing a cancelled appointment's (see the timestamp
 * suffix in lib/cvent/push.ts and the engine's id generation).
 *
 * @param {string} eventCode - Internal event code; translated to the Cvent appointment-event id.
 * @param {string} apptId - The Cvent appointment id to cancel.
 * @returns {Promise<void>}
 */
export async function cancelAppointment(
    eventCode: string,
    apptId: string,
): Promise<void> {
    if (isMock()) return;

    const id = await getAppointmentEventId(eventCode);
    await getClient().appointments.cancelAppointment({ id, apptId });
}
