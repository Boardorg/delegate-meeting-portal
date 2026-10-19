import type { Attendee } from "@/types";

/** One Cvent registration, with its email already normalized for matching. */
export type NormalizedCventAttendee = {
    /** Lowercased email with any testing-mode obfuscation removed. */
    email: string;
    /** Cvent contact id, used as the appointment host or attendee id. */
    contactId: string;
    /** True when the registration's Cvent status is Cancelled. */
    cancelled: boolean;
};

/**
 * Keeps only attendees who also exist in Cvent, matched by email.
 * Each kept attendee gets its Cvent contact id and cancelled flag.
 * Kept separate from the loader so the matching can be unit-tested without Salesforce or Cvent.
 *
 * @param {Attendee[]} attendees - Attendees loaded from Salesforce.
 * @param {NormalizedCventAttendee[]} cventAttendees - The event's Cvent registrations.
 * @returns {Attendee[]} The attendees found in Cvent, enriched with their Cvent data.
 */
export function matchCventAttendees(
    attendees: Attendee[],
    cventAttendees: NormalizedCventAttendee[],
): Attendee[] {
    return attendees.flatMap((a) => {
        if (!a.email) return [];
        const matches = cventAttendees.filter(
            (c) => c.email === a.email.toLowerCase(),
        );
        if (matches.length === 0) return [];

        // One email can have more than one registration, such as a cancelled one and a newer active one.
        // The active registration wins, so a re-registered person isn't treated as cancelled.
        const match = matches.find((c) => !c.cancelled) ?? matches[0];

        // Cancelled attendees are kept so admins can still see and reassign their meetings.
        return [
            {
                ...a,
                cventContactId: match.contactId,
                cventCancelled: match.cancelled,
            },
        ];
    });
}

/**
 * Removes delegate records that are really sponsor reps.
 * The delegate list is every Cvent registrant for the event.
 * Sponsor reps must be Cvent registrants to host appointments, so they land on it too.
 * Nobody is both a sponsor rep and a delegate, so a delegate sharing a rep's Cvent contact is that rep.
 * Left in, the scheduler books the rep under both roles at the same time and Cvent rejects the second booking.
 * Run this after matchCventAttendees, once every attendee has its Cvent contact id.
 *
 * @param {Attendee[]} attendees - Attendees with their Cvent contact ids filled in.
 * @returns {Attendee[]} The same list without delegate copies of sponsor reps.
 */
export function dropSponsorDelegateRecords(attendees: Attendee[]): Attendee[] {
    const sponsorContactIds = new Set(
        attendees
            .filter((a) => a.role === "sponsor" && a.cventContactId)
            .map((a) => a.cventContactId),
    );
    return attendees.filter(
        (a) =>
            a.role !== "delegate" || !sponsorContactIds.has(a.cventContactId),
    );
}
