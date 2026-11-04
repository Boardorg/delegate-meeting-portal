import type { Location, Timeslot } from "@/types";
import type { SponsorCompany } from "@/lib/attendees/companies";
import { companyMaximumMeetings } from "@/lib/attendees/caps";

// ---------------------------------------------------------------------------
// Sponsor booths
//
// Each sponsor company meets only at its own booth.
// Salesforce holds the booth number on the sponsor Opportunity (Booth_No__c).
// This module turns that number into a Cvent location.
// An admin's manual mapping for the booth number wins.
// Otherwise the location named "Booth <number>" is used.
//
// This module is pure, with no server-only imports.
// The scheduler, the admin meeting editor and the Sponsor booths page all share it.
// ---------------------------------------------------------------------------

/**
 * An event's manual booth mapping, from a trimmed booth number to a Cvent location id.
 * Stored as jsonb in event_settings.booth_locations.
 * For example { "3": "a1c30445-..." }.
 * A booth number with no entry uses the automatic match.
 */
export type BoothLocations = Record<string, string>;

/**
 * Why a company gets no meetings because of its booth or package.
 * - no_booth: Booth_No__c is blank.
 * - booth_not_found: no Cvent location matches the booth, or its manual mapping points to a location Cvent no longer returns.
 * - booth_conflict: another company has the same booth location.
 * - multiple_opportunities: the company's reps are on more than one Opportunity for the event.
 * - no_package_meetings: the company's meeting counts give it 0 meetings.
 */
export type BoothProblem =
    | "no_booth"
    | "booth_not_found"
    | "booth_conflict"
    | "multiple_opportunities"
    | "no_package_meetings";

/** Plain labels for each booth problem, for the admin pages and the run report. */
export const BOOTH_PROBLEM_LABEL: Record<BoothProblem, string> = {
    no_booth: "No booth",
    booth_not_found: "Booth not found in Cvent",
    booth_conflict: "Booth shared with another company",
    multiple_opportunities: "Reps on more than one Opportunity",
    no_package_meetings: "No meetings in package",
};

/** How a company's booth location was found. */
export type BoothMatchSource = "manual" | "automatic";

/** A company's booth, resolved against the event's Cvent locations. */
export interface CompanyBooth {
    /** The company's Account id (its party id). */
    accountId: string;
    /** The booth number from Salesforce, trimmed. Null when blank. */
    boothNo: string | null;
    /** The Cvent location the booth resolves to. Null when nothing matches. */
    location: Location | null;
    /** Whether the location came from a manual mapping or the name match. Null when there is no location. */
    source: BoothMatchSource | null;
    /** The location id stored in the manual mapping for this booth number, even when Cvent no longer has it. */
    manualLocationId: string | null;
    /** The location the name match gives, shown on the booths page when there is no manual mapping. */
    automaticLocation: Location | null;
    /**
     * Every problem that applies, in a fixed order.
     * The order is no_booth or booth_not_found, then booth_conflict, multiple_opportunities and no_package_meetings.
     * Empty when the company can be scheduled.
     */
    problems: BoothProblem[];
}

/**
 * Normalizes a booth number for storage and lookup: trimmed, and null when blank.
 *
 * @param {string | null | undefined} boothNo - The raw booth number.
 * @returns {string | null} The trimmed booth number, or null.
 */
export function normalizeBoothNo(
    boothNo: string | null | undefined,
): string | null {
    const t = (boothNo ?? "").trim();
    return t === "" ? null : t;
}

/**
 * Lowercases and trims a name, so the booth match ignores case and spaces at the ends.
 *
 * @param {string} name - A location name or booth label.
 * @returns {string} The comparison key.
 */
function nameKey(name: string): string {
    return name.trim().toLowerCase();
}

/**
 * Finds the Cvent location for a booth number by name.
 * The location must be named "Booth " followed by the booth number.
 * A booth number that already reads "Booth 3" matches "Booth 3" too.
 * Case and spaces at the ends are ignored, so "3" matches "booth 3" but never "Booth 13".
 * When two locations share the name, the first one Cvent lists wins.
 *
 * @param {string | null | undefined} boothNo - The booth number from Salesforce.
 * @param {Location[]} locations - The event's Cvent locations.
 * @returns {Location | null} The matching location, or null.
 */
export function autoMatchBoothLocation(
    boothNo: string | null | undefined,
    locations: Location[],
): Location | null {
    const booth = normalizeBoothNo(boothNo);
    if (!booth) return null;
    const wanted = new Set([nameKey(`Booth ${booth}`), nameKey(booth)]);
    return locations.find((l) => wanted.has(nameKey(l.name))) ?? null;
}

/**
 * Resolves one booth number to a Cvent location.
 * A manual mapping for the booth number wins over the name match.
 * A manual mapping to a location Cvent no longer returns gives no location, rather than falling back.
 *
 * @param {string | null | undefined} boothNo - The booth number from Salesforce.
 * @param {Location[]} locations - The event's Cvent locations.
 * @param {BoothLocations | null | undefined} mappings - The event's manual booth mapping.
 * @returns {{ location: Location | null; source: BoothMatchSource | null; manualLocationId: string | null; automaticLocation: Location | null }} The resolved booth.
 */
export function resolveBoothLocation(
    boothNo: string | null | undefined,
    locations: Location[],
    mappings: BoothLocations | null | undefined,
): {
    location: Location | null;
    source: BoothMatchSource | null;
    manualLocationId: string | null;
    automaticLocation: Location | null;
} {
    const booth = normalizeBoothNo(boothNo);
    const automaticLocation = autoMatchBoothLocation(booth, locations);
    const manualLocationId = booth ? (mappings?.[booth] ?? null) : null;
    if (manualLocationId) {
        const location = locations.find((l) => l.id === manualLocationId) ?? null;
        return {
            location,
            source: location ? "manual" : null,
            manualLocationId,
            automaticLocation,
        };
    }
    return {
        location: automaticLocation,
        source: automaticLocation ? "automatic" : null,
        manualLocationId: null,
        automaticLocation,
    };
}

/**
 * Resolves every company's booth and lists the problems that stop its meetings.
 * Conflicts are found after mapping, so two booth numbers mapped to the same location conflict.
 * Every company that has a location counts as claiming it, whatever its other problems.
 *
 * @param {SponsorCompany[]} companies - The event's sponsor companies.
 * @param {Location[]} locations - The event's Cvent locations.
 * @param {BoothLocations | null | undefined} mappings - The event's manual booth mapping.
 * @returns {Map<string, CompanyBooth>} Each company's booth, keyed by Account id.
 */
export function resolveCompanyBooths(
    companies: SponsorCompany[],
    locations: Location[],
    mappings: BoothLocations | null | undefined,
): Map<string, CompanyBooth> {
    const out = new Map<string, CompanyBooth>();
    for (const c of companies) {
        const boothNo = normalizeBoothNo(c.boothNo);
        const resolved = resolveBoothLocation(boothNo, locations, mappings);
        out.set(c.accountId, {
            accountId: c.accountId,
            boothNo,
            ...resolved,
            problems: [],
        });
    }

    // Count how many companies claim each location.
    const claims = new Map<string, number>();
    for (const b of out.values()) {
        if (!b.location) continue;
        claims.set(b.location.id, (claims.get(b.location.id) ?? 0) + 1);
    }

    // List each company's problems in a fixed order.
    for (const c of companies) {
        const b = out.get(c.accountId)!;
        if (!b.boothNo) b.problems.push("no_booth");
        else if (!b.location) b.problems.push("booth_not_found");
        if (b.location && (claims.get(b.location.id) ?? 0) > 1) {
            b.problems.push("booth_conflict");
        }
        if (c.multipleOpportunities) b.problems.push("multiple_opportunities");
        if (companyMaximumMeetings(c).maximum <= 0) {
            b.problems.push("no_package_meetings");
        }
    }
    return out;
}

/**
 * The one problem to report for a company, the first in CompanyBooth.problems.
 *
 * @param {Pick<CompanyBooth, "problems"> | undefined} booth - The company's booth.
 * @returns {BoothProblem | null} The first problem, or null when there is none.
 */
export function primaryBoothProblem(
    booth: Pick<CompanyBooth, "problems"> | undefined,
): BoothProblem | null {
    return booth?.problems[0] ?? null;
}

/**
 * Counts the companies that have at least one booth problem.
 *
 * @param {Map<string, CompanyBooth>} booths - Each company's booth.
 * @returns {number} How many companies can't be scheduled.
 */
export function countBoothProblems(booths: Map<string, CompanyBooth>): number {
    return [...booths.values()].filter((b) => b.problems.length > 0).length;
}

/**
 * The location ids that are some company's booth.
 * The editor uses it to keep one company's meetings out of another company's booth.
 *
 * @param {Map<string, CompanyBooth>} booths - Each company's booth.
 * @returns {Map<string, string[]>} Location id to the Account ids that have it as their booth.
 */
export function boothOwnersByLocation(
    booths: Map<string, CompanyBooth>,
): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const b of booths.values()) {
        if (!b.location) continue;
        const owners = out.get(b.location.id) ?? [];
        owners.push(b.accountId);
        out.set(b.location.id, owners);
    }
    return out;
}

/**
 * The event's Cvent locations that have `sponsor_delegate` slots, in Cvent's order.
 * These are the choices in the booths page dropdown.
 *
 * @param {Location[]} locations - The event's Cvent locations.
 * @param {Timeslot[]} timeslots - The event's timeslots.
 * @returns {Location[]} The locations with at least one sponsor slot.
 */
export function sponsorSlotLocations(
    locations: Location[],
    timeslots: Timeslot[],
): Location[] {
    const ids = new Set(
        timeslots
            .filter((t) => t.kind === "sponsor_delegate" && t.locationId)
            .map((t) => t.locationId as string),
    );
    return locations.filter((l) => ids.has(l.id));
}

/**
 * A booth's Cvent per-slot limit, the most meetings any of its sponsor slots can take at once.
 * Cvent stops listing a slot once it is fully booked, so this reads the slots still listed.
 * Null when the location has no listed sponsor slot.
 *
 * @param {string | null | undefined} locationId - The booth's location id.
 * @param {Timeslot[]} timeslots - The event's timeslots.
 * @returns {number | null} The per-slot limit, or null.
 */
export function boothPerSlotLimit(
    locationId: string | null | undefined,
    timeslots: Timeslot[],
): number | null {
    if (!locationId) return null;
    const caps = timeslots
        .filter((t) => t.kind === "sponsor_delegate" && t.locationId === locationId)
        .map((t) => t.capacity);
    return caps.length > 0 ? Math.max(...caps) : null;
}

/**
 * Checks a manual mapping before it is saved.
 * The booth number must not be blank.
 * A location id must be one of the event's Cvent locations.
 * A null location id removes the mapping, which is always allowed.
 *
 * @param {string} boothNo - The booth number to map.
 * @param {string | null} locationId - The Cvent location id, or null to use the automatic match.
 * @param {Location[]} locations - The event's Cvent locations.
 * @returns {{ ok: true; boothNo: string } | { ok: false; error: string }} The trimmed booth number, or an error.
 */
export function validateBoothMapping(
    boothNo: string,
    locationId: string | null,
    locations: Location[],
): { ok: true; boothNo: string } | { ok: false; error: string } {
    const booth = normalizeBoothNo(boothNo);
    if (!booth) return { ok: false, error: "Error: booth number is required" };
    if (locationId !== null && !locations.some((l) => l.id === locationId)) {
        return {
            ok: false,
            error: "Error: that location isn't one of this event's Cvent locations",
        };
    }
    return { ok: true, boothNo: booth };
}

/**
 * Returns a new booth mapping with one booth number set or removed.
 * Keys are trimmed booth numbers.
 * An empty mapping becomes null, so it is stored as SQL NULL.
 *
 * @param {BoothLocations | null | undefined} current - The stored mapping.
 * @param {string} boothNo - The trimmed booth number.
 * @param {string | null} locationId - The location id to map to, or null to remove the mapping.
 * @returns {BoothLocations | null} The new mapping.
 */
export function withBoothMapping(
    current: BoothLocations | null | undefined,
    boothNo: string,
    locationId: string | null,
): BoothLocations | null {
    const next: BoothLocations = { ...(current ?? {}) };
    if (locationId === null) delete next[boothNo];
    else next[boothNo] = locationId;
    return Object.keys(next).length > 0 ? next : null;
}
