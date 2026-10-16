import type { Attendee } from "@/types";
import { normalizeEmail } from "@/lib/auth/email";

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
