import { AttendeeProfile } from '@/types';

/**
 * Converts a raw annual revenue number to a display tier string. Only used on
 * the SPONSOR path, where the value comes from Account.AnnualRevenue as a
 * number; delegates get pre-worded text straight from the intake form. Returns
 * the value as-is if it is already a string, or null if the input is
 * null/undefined.
 */
export function formatRevenue(n: number | string | null): string | null {
    if (n === null || n === undefined) return null;
    if (typeof n === 'string') return n;
    if (n < 10_000_000) return '<10M';
    if (n < 50_000_000) return '10M-50M';
    if (n < 100_000_000) return '50M-100M';
    if (n < 500_000_000) return '100M-500M';
    if (n < 1_000_000_000) return '500M-1B';
    if (n < 5_000_000_000) return '1B-5B';
    return '>5B';
}

/**
 * Converts a raw employee count to a display tier string. Sponsor path only,
 * for the same reason as formatRevenue. Returns the value as-is if it is
 * already a string, or null if the input is null/undefined.
 */
export function formatCompanySize(n: number | string | null): string | null {
    if (n === null || n === undefined) return null;
    if (typeof n === 'string') return n;
    if (n <= 50) return '1-50';
    if (n <= 200) return '51-200';
    if (n <= 500) return '200-500';
    if (n <= 1000) return '500-1000';
    if (n <= 5000) return '1000-5000';
    return '>5000';
}

/**
 * Splits a semicolon-delimited Salesforce value into individual strings.
 *
 * This is how every multi-answer value reaches us: multiselect picklists pack
 * their selections as "A;B", and the intake-form answers on
 * CventEvents__Attendee__c are stored the same way as plain text. Accepts a
 * single string or an array of them (an array element may itself be packed), so
 * it is safe to call on already-split data — which is what makes formatProfile
 * idempotent.
 *
 * @param {string | string[] | null | undefined} raw - The packed value(s).
 * @returns {string[]} The individual, trimmed, non-empty values.
 */
export function splitPicklist(
    raw: string | string[] | null | undefined,
): string[] {
    if (raw === null || raw === undefined) return [];
    const parts = Array.isArray(raw) ? raw : [raw];
    return parts.flatMap(s => String(s).split(';').map(v => v.trim())).filter(Boolean);
}

/**
 * Builds a profile with every field unset.
 *
 * For the callers that have no profile source at all — a login identity resolved
 * from the local users table, and test fixtures — so that adding a field to
 * AttendeeProfile doesn't mean editing the same empty literal in five places.
 * The role mappers in lib/salesforce/attendeeMapper.ts deliberately spell every
 * field out instead, so it stays obvious where each one comes from.
 *
 * @returns {AttendeeProfile} A profile with all fields null / empty.
 */
export function emptyProfile(): AttendeeProfile {
    return {
        annualRevenue: null,
        budgetaryResponsibility: null,
        companySize: null,
        industrySectors: [],
        interestAreas: [],
        transformationStage: null,
        systemsAndPlatforms: [],
        meetingInterests: [],
        priorityInitiative: null,
    };
}

/**
 * Applies all display-layer transformations to a raw profile object: every
 * multi-value field is normalized to a flat array of individual values.
 *
 * Revenue / company-size bucketing is NOT done here — that only applies to the
 * numeric Account fields on the sponsor path and happens in that role's field
 * mapper (lib/salesforce/attendeeMapper.ts), so by the time a profile reaches
 * this function both are already strings.
 *
 * Safe to call on already-formatted profiles, so the mock JSON source and the
 * Salesforce source can share one pipeline.
 */
export function formatProfile(profile: AttendeeProfile): AttendeeProfile {
    return {
        ...profile,
        industrySectors: splitPicklist(profile.industrySectors),
        interestAreas: splitPicklist(profile.interestAreas),
        systemsAndPlatforms: splitPicklist(profile.systemsAndPlatforms),
        meetingInterests: splitPicklist(profile.meetingInterests),
    };
}
