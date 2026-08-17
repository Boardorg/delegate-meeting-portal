import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users, type User } from "@/lib/db/schema";
import { loadAttendees } from "@/lib/attendees/loader";
import { toE164 } from "@/lib/auth/phone";
import { normalizeEmail } from "@/lib/auth/email";
import type { Attendee, Channel, ResolvedIdentity } from "@/types";

// ---------------------------------------------------------------------------
// Identity resolution — the single place that decides who a phone number or
// email address is.
//
// A verified contact is resolved in priority order:
//   1. The local `users` table (admins and any manually-managed user/sponsor).
//   2. The live Salesforce attendee/sponsor lists for the current event.
//
// Salesforce identity is resolved fresh on every call (not persisted); the
// matched record's `salesforceId` is what later attaches requests/schedules.
// A contact that matches neither is unrecognized → `null`, and the login
// flow rejects it before sending a code.
// ---------------------------------------------------------------------------

/**
 * Shapes a local users-table row into a thin `Attendee`. Most browse/profile
 * fields have no source on a DB user, so they default to empty; the identifying
 * fields (id, salesforceId, email, phone, role) carry through. The DB `admin`
 * and `user` roles map to the `delegate` attendee role; `sponsor` maps through.
 *
 * @param {User} user - The users-table row.
 * @returns {Attendee} A minimally-populated attendee for this user.
 */
function userToAttendee(user: User): Attendee {
    return {
        id: String(user.id),
        cventContactId: "",
        salesforceId: user.salesforceId ?? "",
        accountId: "",
        name: user.username ?? "",
        email: user.email ?? "",
        phone: user.phone,
        role: user.role === "sponsor" ? "sponsor" : "delegate",
        company: "",
        title: "",
        sponsorTier: null,
        profile: {
            annualRevenue: null,
            budgetaryResponsibility: null,
            areasOfSpecialization: [],
            industrySectors: [],
            plannedSpend: null,
            companySize: null,
            regionsOverseen: [],
            strategicPriorities: [],
        },
        scheduling: { maxSameCompanyMeetings: null },
    };
}

/**
 * True when two phone numbers refer to the same line. Both sides are pushed
 * through `toE164` so formatting (spaces, parens) and a missing US country
 * code don't cause a miss. Returns false if either side can't be parsed.
 *
 * @param {string} a - First phone (any format).
 * @param {string} b - Second phone (any format).
 * @returns {boolean} Whether they normalize to the same E.164 number.
 */
function phonesMatch(a: string, b: string): boolean {
    const ae = toE164(a);
    const be = toE164(b);
    return ae !== null && be !== null && ae === be;
}

/**
 * True when two email addresses are the same login identity. Both sides are
 * pushed through `normalizeEmail` (trim + lowercase) so casing and stray
 * whitespace don't cause a miss. Returns false if either side can't be parsed.
 *
 * @param {string} a - First email (any casing).
 * @param {string} b - Second email (any casing).
 * @returns {boolean} Whether they normalize to the same address.
 */
function emailsMatch(a: string, b: string): boolean {
    const ae = normalizeEmail(a);
    const be = normalizeEmail(b);
    return ae !== null && be !== null && ae === be;
}

/**
 * Resolves who a verified phone number or email address belongs to. Checks
 * the local users table first, then falls back to matching the live
 * Salesforce attendee/sponsor lists by the same channel.
 *
 * @param {string} contact - A normalized phone number or email, matching `channel`.
 * @param {Channel} channel - "sms" to resolve by phone, "email" to resolve by email.
 * @param {string} [eventCode] - Explicit event code for the attendee lookup,
 *   used by the login flow before a session (and thus getEventCode) is available.
 * @returns {Promise<ResolvedIdentity | null>} The identity, or null if unrecognized.
 */
export async function resolveIdentity(
    contact: string,
    channel: Channel,
    eventCode?: string,
): Promise<ResolvedIdentity | null> {
    // 1. Local users table — admins and any manually-managed user/sponsor.
    const [user] =
        channel === "email"
            ? await db.select().from(users).where(eq(users.email, contact)).limit(1)
            : await db.select().from(users).where(eq(users.phone, contact)).limit(1);
    if (user) {
        return {
            contact,
            channel,
            role: user.role,
            source: "users",
            salesforceId: user.salesforceId ?? null,
            user,
            attendee: userToAttendee(user),
        };
    }

    // 2. Live Salesforce (or mock) attendee list, matched by the same
    //    channel. Delegates become "user"; sponsors become "sponsor".
    const attendees = await loadAttendees(false, eventCode);
    const attendee = attendees.find((a) =>
        channel === "email"
            ? a.email && emailsMatch(a.email, contact)
            : a.phone && phonesMatch(a.phone, contact),
    );
    if (attendee) {
        return {
            contact,
            channel,
            role: attendee.role === "sponsor" ? "sponsor" : "user",
            source: "salesforce",
            salesforceId: attendee.salesforceId || null,
            user: null,
            attendee,
        };
    }

    // Unrecognized.
    return null;
}
