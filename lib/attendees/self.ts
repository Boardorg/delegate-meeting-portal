import type { Attendee } from "@/types";
import { normalizeEmail } from "@/lib/auth/email";
import { partyId } from "@/lib/attendees/companies";

/**
 * Whether an attendee record belongs to the logged-in person.
 * Used to keep people from seeing themselves in the catalog.
 *
 * A matching Salesforce id is the strongest signal.
 * Email is checked too, for two reasons.
 * A login from the local users table may have no Salesforce id.
 * The same person can also have a sponsor record and a delegate record with different ids.
 *
 * @param {Attendee} attendee - A catalog entry.
 * @param {Attendee} viewer - The logged-in person's attendee record.
 * @returns {boolean} True when both records are the same person.
 */
export function isSameAttendee(attendee: Attendee, viewer: Attendee): boolean {
    if (
        viewer.salesforceId &&
        attendee.salesforceId === viewer.salesforceId
    ) {
        return true;
    }
    const viewerEmail = normalizeEmail(viewer.email);
    return viewerEmail !== null && normalizeEmail(attendee.email) === viewerEmail;
}

/**
 * Whether an attendee is on the logged-in person's own side, so the catalog should hide them.
 * That is always the person themselves.
 * A sponsor rep represents their whole company, the same party id their requests and meetings use.
 * So a sponsor also doesn't see anyone whose Salesforce Account is their company.
 * Delegates are individuals, so for them this is only themselves.
 *
 * @param {Attendee} attendee - A catalog entry.
 * @param {Attendee} viewer - The logged-in person's attendee record.
 * @returns {boolean} True when the catalog should hide this attendee from the viewer.
 */
export function isOwnParty(attendee: Attendee, viewer: Attendee): boolean {
    if (isSameAttendee(attendee, viewer)) return true;
    if (viewer.role !== "sponsor" || !viewer.accountId) return false;
    return attendee.accountId === partyId(viewer);
}
