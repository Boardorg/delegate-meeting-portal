import "server-only";
import { loadAttendees } from "./loader";
import type { Attendee } from "@/types";

// ---------------------------------------------------------------------------
// Attendee lookup by Salesforce id.
//
// Meeting requests and schedules reference attendees by Salesforce id. These
// helpers resolve those ids back to full Attendee objects for display. Pass an
// explicit eventCode to resolve a specific event; omit it to use the
// request-resolved event.
// ---------------------------------------------------------------------------

/**
 * Builds a `salesforceId → Attendee` map for an event. Attendees without a
 * Salesforce id are skipped (they can't be a request target/requester).
 *
 * @param {string} [eventCode] - Event to load; omitted uses getEventCode().
 * @returns {Promise<Map<string, Attendee>>} Lookup keyed by Salesforce id.
 */
export async function attendeesBySalesforceId(
    eventCode?: string,
): Promise<Map<string, Attendee>> {
    const attendees = await loadAttendees(false, eventCode);
    const map = new Map<string, Attendee>();
    for (const a of attendees) {
        if (a.salesforceId) map.set(a.salesforceId, a);
    }
    return map;
}

/**
 * Resolves a single attendee by Salesforce id for an event, or undefined.
 *
 * @param {string} salesforceId - The attendee's Salesforce id.
 * @param {string} [eventCode] - Event to load; omitted uses getEventCode().
 * @returns {Promise<Attendee | undefined>} The matching attendee, if any.
 */
export async function getAttendeeBySalesforceId(
    salesforceId: string,
    eventCode?: string,
): Promise<Attendee | undefined> {
    return (await attendeesBySalesforceId(eventCode)).get(salesforceId);
}
