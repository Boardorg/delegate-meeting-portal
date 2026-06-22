import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
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

/** Translates an internal event code to its Cvent appointment-event id. Hardcoded stub for now. */
function eventCodeToCventId(_eventCode: string): string {
    return "00000000-0000-4000-8000-000000000000";
}

// ---------------------------------------------------------------------------
// SDK client (singleton)
// ---------------------------------------------------------------------------

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

    sdk = new CventSDK({
        security: {
            oAuth2ClientCredentials: {
                clientID,
                clientSecret,
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
        throw new Error(`Invalid Cvent mock fixture ${file}: ${String(parsed.error)}`);
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
