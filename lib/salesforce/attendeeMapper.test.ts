import { describe, test, expect } from 'vitest';
import { attendeeFieldMappers, meetingDataToAttendees } from './attendeeMapper';
import type { MappingContext, MeetingDataRecord } from './attendeeMapper';

// ---------------------------------------------------------------------------
// Helpers for generating test data
// ---------------------------------------------------------------------------

/**
 * Returns a minimal MappingContext for tests that need one but don't care about its values.
 *
 * @param {Partial<MappingContext>} overrides - Optional fields to override on the default context.
 * @returns {MappingContext} A context with safe defaults.
 */
function makeContext(overrides: Partial<MappingContext> = {}): MappingContext {
    return { role: 'delegate', index: 0, usePlaceholders: false, ...overrides };
}

/**
 * Builds a MeetingDataRecord with a nested Delegate__r contact block.
 *
 * @param {string | null} firstName - The contact's first name.
 * @param {string | null} lastName - The contact's last name.
 * @returns {MeetingDataRecord} A record with the specified name fields set.
 */
function makeNameRecord(firstName: string | null, lastName: string | null): MeetingDataRecord {
    return { Delegate__r: { FirstName: firstName, LastName: lastName } };
}

/**
 * Builds a MeetingDataRecord with a Registration__r block carrying a sponsorship package label.
 *
 * @param {string | null} packageLabel - The Sponsorship_Package__c value from Salesforce.
 * @returns {MeetingDataRecord} A record with the specified package label set.
 */
function makePackageRecord(packageLabel: string | null): MeetingDataRecord {
    return { Registration__r: { Sponsorship_Package__c: packageLabel } };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

// Combines first + last name with a space and trims; handles missing name parts gracefully.
describe('attendeeFieldMappers.name', () => {
    const ctx = makeContext();

    test('combines first and last name with a space', () => {
        expect(attendeeFieldMappers.name(makeNameRecord('John', 'Doe'), ctx)).toBe('John Doe');
    });

    test('returns just the first name when last name is missing', () => {
        expect(attendeeFieldMappers.name(makeNameRecord('John', null), ctx)).toBe('John');
    });

    test('returns just the last name when first name is missing', () => {
        expect(attendeeFieldMappers.name(makeNameRecord(null, 'Doe'), ctx)).toBe('Doe');
    });

    test('returns empty string when both names are missing', () => {
        expect(attendeeFieldMappers.name({ Delegate__r: null }, ctx)).toBe('');
    });
});

// Maps Sponsorship_Package__c to the SponsorTier union — critical because it determines meeting caps.
describe('attendeeFieldMappers.sponsorTier', () => {
    const ctx = makeContext();

    test('returns "diamond" when the package label contains "diamond"', () => {
        expect(attendeeFieldMappers.sponsorTier(makePackageRecord('Diamond Package'), ctx)).toBe('diamond');
    });

    test('returns "diamond" for lowercase "diamond" in the label', () => {
        expect(attendeeFieldMappers.sponsorTier(makePackageRecord('diamond'), ctx)).toBe('diamond');
    });

    test('returns "standard" for any non-diamond package label', () => {
        expect(attendeeFieldMappers.sponsorTier(makePackageRecord('Standard Package'), ctx)).toBe('standard');
    });

    test('returns null when the package label is null', () => {
        expect(attendeeFieldMappers.sponsorTier(makePackageRecord(null), ctx)).toBeNull();
    });

    test('returns null when Registration__r is missing', () => {
        expect(attendeeFieldMappers.sponsorTier({}, ctx)).toBeNull();
    });
});

// Maps Account fields into the profile sub-object (industry is the only field with a clean SF source today).
describe('attendeeFieldMappers.profile', () => {
    const ctx = makeContext();

    test('maps industry category into industrySectors array', () => {
        const record: MeetingDataRecord = {
            Delegate__r: { Account: { Industry_Category__c: 'Technology' } },
        };
        expect(attendeeFieldMappers.profile(record, ctx).industrySectors).toEqual(['Technology']);
    });

    test('returns empty industrySectors when industry is missing', () => {
        const record: MeetingDataRecord = { Delegate__r: { Account: { Industry_Category__c: null } } };
        expect(attendeeFieldMappers.profile(record, ctx).industrySectors).toEqual([]);
    });

    test('passes through annualRevenue and companySize from the Account', () => {
        const record: MeetingDataRecord = {
            Delegate__r: { Account: { AnnualRevenue: 5_000_000, NumberOfEmployees: 250 } },
        };
        const profile = attendeeFieldMappers.profile(record, ctx);
        expect(profile.annualRevenue).toBe(5_000_000);
        expect(profile.companySize).toBe(250);
    });

    test('returns nulls for all fields when Delegate__r is missing', () => {
        const profile = attendeeFieldMappers.profile({}, ctx);
        expect(profile.annualRevenue).toBeNull();
        expect(profile.companySize).toBeNull();
        expect(profile.industrySectors).toEqual([]);
    });
});

// Orchestrates all field mappers — verifies role assignment, ordering, and placeholder ID generation.
describe('meetingDataToAttendees', () => {
    test('assigns delegate role to records in the delegates array', () => {
        const result = meetingDataToAttendees({ delegates: [{ Id: 'sf-001' }], sponsors: [] }, false);
        expect(result[0].role).toBe('delegate');
    });

    test('assigns sponsor role to records in the sponsors array', () => {
        const result = meetingDataToAttendees({ delegates: [], sponsors: [{ Id: 'sf-002' }] }, false);
        expect(result[0].role).toBe('sponsor');
    });

    test('returns delegates before sponsors', () => {
        const result = meetingDataToAttendees(
            { delegates: [{ Id: 'sf-d1' }], sponsors: [{ Id: 'sf-s1' }] },
            false
        );
        expect(result[0].role).toBe('delegate');
        expect(result[1].role).toBe('sponsor');
    });

    test('generates stable placeholder IDs (d1, d2, s1) when usePlaceholders is true', () => {
        const result = meetingDataToAttendees(
            { delegates: [{}, {}], sponsors: [{}] },
            true
        );
        expect(result[0].id).toBe('d1');
        expect(result[1].id).toBe('d2');
        expect(result[2].id).toBe('s1');
    });

    test('uses the Salesforce record Id when usePlaceholders is false', () => {
        const result = meetingDataToAttendees({ delegates: [{ Id: 'sf-abc' }], sponsors: [] }, false);
        expect(result[0].id).toBe('sf-abc');
    });
});
