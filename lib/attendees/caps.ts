import type { SponsorTier } from "@/types";
import type { SponsorCompany } from "@/lib/attendees/companies";
import { hostingReps } from "@/lib/attendees/companies";

// ---------------------------------------------------------------------------
// Sponsor meeting counts
//
// One rule for how many meetings a sponsor company may have, and how many at once.
// The scheduler, Manage Meetings, the sponsor page and the Sponsor booths page all use it.
// The tier counts live only here.
// ---------------------------------------------------------------------------

/**
 * The meeting count each tier falls back to when all three Salesforce count fields are blank.
 * Diamond packages get 8, and every other package gets 5.
 */
const TIER_FALLBACK_MEETINGS = { diamond: 8, standard: 5 } as const;

/**
 * Where a company's maximum came from.
 * - maximum: Cvent_Maximum_Meetings__c.
 * - purchased_plus_bonus: Meetings__c plus Cvent_Bonus_Meetings__c.
 * - tier: all three were blank, so the tier count was used.
 */
export type MaximumSource = "maximum" | "purchased_plus_bonus" | "tier";

/** A company's meeting maximum and where it came from. */
export type CompanyMaximum = { maximum: number; source: MaximumSource };

/**
 * The fallback meeting count for a tier.
 *
 * @param {SponsorTier} tier - The company's tier.
 * @returns {number} 8 for diamond, 5 for anything else.
 */
export function tierFallbackMeetings(tier: SponsorTier): number {
    return tier === "diamond"
        ? TIER_FALLBACK_MEETINGS.diamond
        : TIER_FALLBACK_MEETINGS.standard;
}

/**
 * Works out how many meetings a sponsor company may have.
 * Cvent_Maximum_Meetings__c wins when it is set.
 * Otherwise purchased plus bonus is used when either is set, and a blank one counts as 0.
 * Only when all three are blank does the tier count apply.
 * A 0 is not blank, so a company whose fields give 0 gets no meetings.
 *
 * @param {Pick<SponsorCompany, "tier" | "purchasedMeetings" | "bonusMeetings" | "maximumMeetings">} company - The company.
 * @returns {CompanyMaximum} The maximum and its source.
 */
export function companyMaximumMeetings(
    company: Pick<
        SponsorCompany,
        "tier" | "purchasedMeetings" | "bonusMeetings" | "maximumMeetings"
    >,
): CompanyMaximum {
    if (company.maximumMeetings != null) {
        return { maximum: company.maximumMeetings, source: "maximum" };
    }
    if (company.purchasedMeetings != null || company.bonusMeetings != null) {
        return {
            maximum: (company.purchasedMeetings ?? 0) + (company.bonusMeetings ?? 0),
            source: "purchased_plus_bonus",
        };
    }
    return { maximum: tierFallbackMeetings(company.tier), source: "tier" };
}

/**
 * Whether Cvent_Maximum_Meetings__c disagrees with purchased plus bonus.
 * Only checked when the maximum and at least one of the other two are set.
 *
 * @param {Pick<SponsorCompany, "purchasedMeetings" | "bonusMeetings" | "maximumMeetings">} company - The company.
 * @returns {boolean} True when the Sponsor booths page should warn.
 */
export function maximumDiffersFromPackage(
    company: Pick<
        SponsorCompany,
        "purchasedMeetings" | "bonusMeetings" | "maximumMeetings"
    >,
): boolean {
    if (company.maximumMeetings == null) return false;
    if (company.purchasedMeetings == null && company.bonusMeetings == null) {
        return false;
    }
    const total = (company.purchasedMeetings ?? 0) + (company.bonusMeetings ?? 0);
    return company.maximumMeetings !== total;
}

/**
 * The Diaries value a company asked for, with blank counting as 1.
 *
 * @param {Pick<SponsorCompany, "meetingsAtOnce">} company - The company.
 * @returns {number} Cvent_Number_Diaries__c, or 1 when blank.
 */
export function requestedMeetingsAtOnce(
    company: Pick<SponsorCompany, "meetingsAtOnce">,
): number {
    return company.meetingsAtOnce ?? 1;
}

/**
 * How many meetings a company may hold at the same start time.
 * It is the smaller of its Diaries value (blank counts as 1) and the number of its reps who can host in Cvent.
 * It is never below 1.
 * A company with no rep who can host still gets one at a time, as before.
 * Push then reports that no rep can host.
 *
 * @param {SponsorCompany} company - The company.
 * @returns {number} The at-once limit.
 */
export function companyMeetingsAtOnce(company: SponsorCompany): number {
    const limit = Math.min(
        Math.floor(requestedMeetingsAtOnce(company)),
        hostingReps(company).length,
    );
    return Math.max(1, limit);
}
