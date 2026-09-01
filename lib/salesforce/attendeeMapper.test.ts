import { describe, test, expect } from 'vitest';
import {
    attendeeFieldMappers,
    delegateFieldMappers,
    meetingDataToAttendees,
} from './attendeeMapper';
import type {
    CventAttendeeRecord,
    MappingContext,
    MeetingDataRecord,
} from './attendeeMapper';

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

// Maps Account fields into the sponsor profile. Sponsors have no intake form, so
// only the three Account-derived fields can ever be populated — and the two
// numeric ones get bucketed here so AttendeeProfile stays string-only.
describe('attendeeFieldMappers.profile (sponsors)', () => {
    const ctx = makeContext({ role: 'sponsor' });

    test('maps industry category into industrySectors array', () => {
        const record: MeetingDataRecord = {
            Delegate__r: { Account: { Industry_Category__c: 'Technology' } },
        };
        expect(attendeeFieldMappers.profile(record, ctx).industrySectors).toEqual(['Technology']);
    });

    test('splits a semicolon-packed industry picklist into separate sectors', () => {
        const record: MeetingDataRecord = {
            Delegate__r: { Account: { Industry_Category__c: 'Healthcare;Pharmaceuticals' } },
        };
        expect(attendeeFieldMappers.profile(record, ctx).industrySectors).toEqual([
            'Healthcare',
            'Pharmaceuticals',
        ]);
    });

    test('returns empty industrySectors when industry is missing', () => {
        const record: MeetingDataRecord = { Delegate__r: { Account: { Industry_Category__c: null } } };
        expect(attendeeFieldMappers.profile(record, ctx).industrySectors).toEqual([]);
    });

    test('buckets the Account revenue and employee count into tier strings', () => {
        const record: MeetingDataRecord = {
            Delegate__r: { Account: { AnnualRevenue: 5_000_000, NumberOfEmployees: 250 } },
        };
        const profile = attendeeFieldMappers.profile(record, ctx);
        expect(profile.annualRevenue).toBe('<10M');
        expect(profile.companySize).toBe('200-500');
    });

    test('leaves the delegate-only intake fields unset', () => {
        const profile = attendeeFieldMappers.profile({}, ctx);
        expect(profile.budgetaryResponsibility).toBeNull();
        expect(profile.transformationStage).toBeNull();
        expect(profile.priorityInitiative).toBeNull();
        expect(profile.interestAreas).toEqual([]);
        expect(profile.systemsAndPlatforms).toEqual([]);
        expect(profile.meetingInterests).toEqual([]);
    });

    test('returns nulls for all fields when Delegate__r is missing', () => {
        const profile = attendeeFieldMappers.profile({}, ctx);
        expect(profile.annualRevenue).toBeNull();
        expect(profile.companySize).toBeNull();
        expect(profile.industrySectors).toEqual([]);
    });
});

// Identity fields keep their pre-existing Contact/Account sources; they just
// reach them through the CventEvents__Contact__r relationship now.
describe('delegateFieldMappers identity', () => {
    const ctx = makeContext();

    const record: CventAttendeeRecord = {
        Id: 'a3EPZ000000sQWz2AM',
        CventEvents__Email__c: 'registered@example.com',
        CventEvents__Contact__r: {
            FirstName: 'Miriam',
            LastName: 'Kastner',
            Title: 'VP Clinical Data',
            Email: 'miriam@brenvax.com',
            Phone: '+15551234567',
            AccountId: '001PZ000011HVWHYA4',
            Account: { Name: 'Brenvax Pharmaceuticals' },
        },
    };

    test('uses the CventEvents__Attendee__c Id as the storage key', () => {
        expect(delegateFieldMappers.salesforceId(record, ctx)).toBe('a3EPZ000000sQWz2AM');
    });

    test('reads name, title, company and account id through the Contact', () => {
        expect(delegateFieldMappers.name(record, ctx)).toBe('Miriam Kastner');
        expect(delegateFieldMappers.title(record, ctx)).toBe('VP Clinical Data');
        expect(delegateFieldMappers.company(record, ctx)).toBe('Brenvax Pharmaceuticals');
        expect(delegateFieldMappers.accountId(record, ctx)).toBe('001PZ000011HVWHYA4');
    });

    test('prefers the Contact email over the Cvent registration email', () => {
        expect(delegateFieldMappers.email(record, ctx)).toBe('miriam@brenvax.com');
    });

    test('falls back to the Cvent registration email when the Contact has none', () => {
        const noContactEmail: CventAttendeeRecord = {
            ...record,
            CventEvents__Contact__r: { ...record.CventEvents__Contact__r, Email: null },
        };
        expect(delegateFieldMappers.email(noContactEmail, ctx)).toBe('registered@example.com');
    });

    test('never assigns a sponsor tier', () => {
        expect(delegateFieldMappers.sponsorTier(record, ctx)).toBeNull();
    });

    test('degrades to empty strings when the Contact is missing', () => {
        expect(delegateFieldMappers.name({}, ctx)).toBe('');
        expect(delegateFieldMappers.company({}, ctx)).toBe('');
        expect(delegateFieldMappers.title({}, ctx)).toBe('');
        expect(delegateFieldMappers.accountId({}, ctx)).toBe('');
    });
});

// The intake-form answers. Everything arrives as free text; the multi-answer
// questions come back semicolon-delimited.
describe('delegateFieldMappers.profile', () => {
    const ctx = makeContext();

    const record: CventAttendeeRecord = {
        CventEvents__Contact__r: {
            Account: { Industry_Category__c: 'Healthcare;Pharmaceuticals' },
        },
        CventEvents_NP_Annual_Revenue__c: '$1B–$10B',
        CventEvents_NP_Budget_Responsibility__c: '$50M–$250M',
        CventEvents_NP_Company_Size__c: 'More than 5,000',
        CventEvents_NP_Current_Focus_Topics__c: 'AI & Machine Learning;Data Governance',
        CventEvents_NP_Transformation_Stage__c: 'Scaling up',
        CventEvents_NP_Systems_and_Platforms__c: 'Veeva Vault;Snowflake;AWS',
        CventEvents_NP_One_to_One_Interests__c: 'Data & Analytics;Automation',
        CventEvents_NP_Initiative_Priority__c: 'AI-assisted drug discovery',
    };

    test('maps each intake field to its profile field', () => {
        const profile = delegateFieldMappers.profile(record, ctx);
        expect(profile.annualRevenue).toBe('$1B–$10B');
        expect(profile.budgetaryResponsibility).toBe('$50M–$250M');
        expect(profile.companySize).toBe('More than 5,000');
        expect(profile.transformationStage).toBe('Scaling up');
        expect(profile.priorityInitiative).toBe('AI-assisted drug discovery');
    });

    test('splits the multi-answer fields on semicolons', () => {
        const profile = delegateFieldMappers.profile(record, ctx);
        expect(profile.interestAreas).toEqual(['AI & Machine Learning', 'Data Governance']);
        expect(profile.systemsAndPlatforms).toEqual(['Veeva Vault', 'Snowflake', 'AWS']);
        expect(profile.meetingInterests).toEqual(['Data & Analytics', 'Automation']);
    });

    test('keeps sourcing industry sectors from the Account', () => {
        expect(delegateFieldMappers.profile(record, ctx).industrySectors).toEqual([
            'Healthcare',
            'Pharmaceuticals',
        ]);
    });

    test('collapses blank answers to null so the UI and filters skip them', () => {
        const blank: CventAttendeeRecord = {
            CventEvents_NP_Annual_Revenue__c: '   ',
            CventEvents_NP_Transformation_Stage__c: '',
        };
        const profile = delegateFieldMappers.profile(blank, ctx);
        expect(profile.annualRevenue).toBeNull();
        expect(profile.transformationStage).toBeNull();
    });

    test('returns an unset profile for a delegate who never filled in the form', () => {
        const profile = delegateFieldMappers.profile({}, ctx);
        expect(profile.annualRevenue).toBeNull();
        expect(profile.budgetaryResponsibility).toBeNull();
        expect(profile.companySize).toBeNull();
        expect(profile.transformationStage).toBeNull();
        expect(profile.priorityInitiative).toBeNull();
        expect(profile.industrySectors).toEqual([]);
        expect(profile.interestAreas).toEqual([]);
        expect(profile.systemsAndPlatforms).toEqual([]);
        expect(profile.meetingInterests).toEqual([]);
    });
});

// Orchestrates all field mappers — verifies role assignment, ordering, and placeholder ID generation.
describe('meetingDataToAttendees', () => {
    test('assigns delegate role to records in the delegates array', () => {
        const result = meetingDataToAttendees({ delegates: [{ Id: 'sf-001' }], sponsors: [] }, false);
        expect(result[0].role).toBe('delegate');
    });

    test('applies the per-role mapper set: only the sponsor reads Delegate__r', () => {
        const contactBlock = { FirstName: 'Ada', LastName: 'Byron' };
        const result = meetingDataToAttendees(
            {
                delegates: [{ CventEvents__Contact__r: contactBlock }],
                sponsors: [{ Delegate__r: contactBlock }],
            },
            false,
        );
        // Each role resolved its name through its own object's relationship.
        expect(result[0].name).toBe('Ada Byron');
        expect(result[1].name).toBe('Ada Byron');
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
