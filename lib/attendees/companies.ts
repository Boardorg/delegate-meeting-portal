import type { Attendee, SponsorTier } from "@/types";

// ---------------------------------------------------------------------------
// Company (sponsor) grouping — the "party id" abstraction.
//
// Sponsors send multiple reps from the same company. The unit of identity on
// the sponsor side is the COMPANY (its Salesforce Account id), not the
// individual rep: any rep can request/see/edit on the company's behalf, the
// engine schedules the company as one entity with a shared budget, and a Cvent
// appointment is hosted by ALL the company's reps.
//
// The "party id" of a participant is:
//   - sponsor  → its Account id (all reps of a company share it)
//   - delegate → its salesforceId (delegates stay individuals)
//
// This module is the single source of truth for party identity and company
// grouping. It is PURE (no server-only imports) so both server code and the
// client `SponsorCatalog` can use it. Callers pass in the already-loaded
// Attendee[]; nothing here touches Salesforce/Cvent/DB directly.
// ---------------------------------------------------------------------------

/**
 * The scheduling/storage identity of a participant: the employer Account id for
 * sponsors, the salesforceId for delegates. A sponsor with no Account id falls
 * back to its own salesforceId, so it behaves as its own single-rep company
 * instead of collapsing every account-less sponsor under an empty key.
 *
 * @param {Attendee} attendee - The attendee.
 * @returns {string} The party id.
 */
export function partyId(attendee: Attendee): string {
    if (attendee.role === "sponsor") {
        return attendee.accountId || attendee.salesforceId;
    }
    return attendee.salesforceId;
}

/**
 * A sponsor company: one entity bundling all reps that share an Account id.
 */
export interface SponsorCompany {
    /** Account id == the party id shared by every rep. */
    accountId: string;
    /** Display name (the reps' company name). */
    name: string;
    /** Tier resolved across the reps (highest wins — see resolveCompanyTier). */
    tier: SponsorTier;
    /** All reps belonging to this company. */
    reps: Attendee[];
}

/**
 * Resolves a company's tier from its reps, highest wins: diamond if any rep is
 * diamond, else standard if any is standard, else null. This honors the top
 * package purchased even if reps' registrations carry different packages.
 *
 * @param {Attendee[]} reps - The company's reps.
 * @returns {SponsorTier} The resolved company tier.
 */
export function resolveCompanyTier(reps: Attendee[]): SponsorTier {
    if (reps.some((r) => r.sponsorTier === "diamond")) return "diamond";
    if (reps.some((r) => r.sponsorTier === "standard")) return "standard";
    return null;
}

/**
 * Groups sponsor attendees into companies keyed by party id (Account id).
 * Non-sponsors are ignored. Each company's tier is resolved across its reps.
 *
 * @param {Attendee[]} attendees - The full attendee list.
 * @returns {Map<string, SponsorCompany>} Companies keyed by party id.
 */
export function sponsorCompaniesByAccountId(
    attendees: Attendee[],
): Map<string, SponsorCompany> {
    const map = new Map<string, SponsorCompany>();
    for (const a of attendees) {
        if (a.role !== "sponsor") continue;
        const key = partyId(a);
        const existing = map.get(key);
        if (existing) {
            existing.reps.push(a);
        } else {
            map.set(key, {
                accountId: key,
                name: a.company,
                tier: a.sponsorTier,
                reps: [a],
            });
        }
    }
    // Resolve each company's tier once all reps are collected.
    for (const company of map.values()) {
        company.tier = resolveCompanyTier(company.reps);
    }
    return map;
}

/**
 * The Cvent contact ids of a company's reps (truthy only). These become the
 * appointment HOSTS when a company meeting is pushed to Cvent. Reps without a
 * Cvent contact id are excluded (they can't host).
 *
 * @param {SponsorCompany} company - The company.
 * @returns {string[]} Rep Cvent contact ids (deduped, truthy).
 */
export function cventContactIdsOfCompany(company: SponsorCompany): string[] {
    const ids = company.reps
        .map((r) => r.cventContactId)
        .filter((id): id is string => !!id);
    return [...new Set(ids)];
}

/**
 * Resolves a party id to a human-readable name + company, checking the company
 * map first (sponsor account ids) then the per-attendee map (delegates /
 * individual reps). Used by admin displays that show a request's requester,
 * which is now a company party id on the sponsor side.
 *
 * @param {string} id - The party id.
 * @param {Map<string, SponsorCompany>} companies - Company map (by account id).
 * @param {Map<string, Attendee>} bySalesforceId - Attendee map (by salesforceId).
 * @returns {{ name: string; company: string } | undefined} The resolved party.
 */
export function resolvePartyName(
    id: string,
    companies: Map<string, SponsorCompany>,
    bySalesforceId: Map<string, Attendee>,
): { name: string; company: string } | undefined {
    const company = companies.get(id);
    if (company) return { name: company.name, company: company.name };
    const attendee = bySalesforceId.get(id);
    if (attendee) return { name: attendee.name, company: attendee.company };
    return undefined;
}
