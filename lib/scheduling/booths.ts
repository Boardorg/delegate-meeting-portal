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
