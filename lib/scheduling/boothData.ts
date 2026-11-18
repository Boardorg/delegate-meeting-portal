import "server-only";
import { getEventSettings } from "@/lib/events/settings";
import { sponsorCompaniesByAccountId } from "@/lib/attendees/companies";
import {
    resolveCompanyBooths,
    type BoothLocations,
    type CompanyBooth,
} from "@/lib/scheduling/booths";
import type { Attendee, Location } from "@/types";

// ---------------------------------------------------------------------------
// Loading each sponsor company's booth for an event.
//
// Reads the event's manual booth mapping from event_settings, then resolves
// every company with the pure helpers in lib/scheduling/booths.ts.
// The scheduler run, the meeting editor and the Sponsor booths page all load booths here.
// ---------------------------------------------------------------------------

/** Shown when the event's manual booth mapping can't be read. */
export const BOOTH_MAPPING_UNAVAILABLE_MESSAGE =
    "The portal couldn't read this event's booth mapping, so nothing was changed. " +
    "Try again in a few minutes.";

/**
 * Result of loading the event's booths.
 * A failed read is a result rather than a thrown error, so callers can stop safely and say why.
 */
export type CompanyBoothsLoad =
    | { ok: true; booths: Map<string, CompanyBooth>; mappings: BoothLocations | null }
    | { ok: false; error: string };

/**
 * Reads an event's manual booth mapping.
 *
 * @param {string} eventCode - The event.
 * @returns {Promise<{ ok: true; mappings: BoothLocations | null } | { ok: false; error: string }>} The mapping, or why it couldn't be read.
 */
export async function loadBoothLocations(
    eventCode: string,
): Promise<
    { ok: true; mappings: BoothLocations | null } | { ok: false; error: string }
> {
    try {
        const settings = await getEventSettings(eventCode);
        return { ok: true, mappings: settings?.boothLocations ?? null };
    } catch (err) {
        console.warn(
            `loadBoothLocations: could not read the booth mapping for "${eventCode}". ` +
                `${err instanceof Error ? err.message : String(err)}`,
        );
        return { ok: false, error: BOOTH_MAPPING_UNAVAILABLE_MESSAGE };
    }
}

/**
 * Resolves every sponsor company's booth for an event.
 * Pass every attendee, including cancelled ones, so a company's booth claim doesn't depend on who is still registered.
 *
 * @param {string} eventCode - The event.
 * @param {Attendee[]} attendees - The event's attendees.
 * @param {Location[]} locations - The event's Cvent locations.
 * @returns {Promise<CompanyBoothsLoad>} Each company's booth, or why the mapping couldn't be read.
 */
export async function loadCompanyBooths(
    eventCode: string,
    attendees: Attendee[],
    locations: Location[],
): Promise<CompanyBoothsLoad> {
    const loaded = await loadBoothLocations(eventCode);
    if (!loaded.ok) return loaded;
    const companies = [...sponsorCompaniesByAccountId(attendees).values()];
    return {
        ok: true,
        booths: resolveCompanyBooths(companies, locations, loaded.mappings),
        mappings: loaded.mappings,
    };
}
