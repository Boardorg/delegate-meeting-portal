import { describe, test, expect } from 'vitest';
import {
    answerOrNull,
    emptyProfile,
    formatCompanySize,
    formatProfile,
    formatRevenue,
    isNonAnswer,
    splitPicklist,
} from './formatProfile';

// ---------------------------------------------------------------------------
// Non-answer handling.
//
// The intake form offers "Undisclosed" on the money questions and "Other" on
// the multi-selects. Neither tells a requester anything, and left in place
// "Undisclosed" would take one of the revenue chip's color bands and both would
// show up as dead-end sidebar filter options.
// ---------------------------------------------------------------------------

describe('isNonAnswer', () => {
    test('matches the form\'s non-answers regardless of case or padding', () => {
        expect(isNonAnswer('Undisclosed')).toBe(true);
        expect(isNonAnswer('undisclosed')).toBe(true);
        expect(isNonAnswer('  Other  ')).toBe(true);
        expect(isNonAnswer('Not disclosed')).toBe(true);
    });

    test('keeps a real answer that merely begins with one of those words', () => {
        expect(isNonAnswer('Other Learning Systems')).toBe(false);
        expect(isNonAnswer('Organizational Development')).toBe(false);
    });
});

describe('answerOrNull', () => {
    test('trims a real answer', () => {
        expect(answerOrNull('  $5B–$10B ')).toBe('$5B–$10B');
    });

    test('collapses non-answers to null, like an unanswered question', () => {
        expect(answerOrNull('Undisclosed')).toBeNull();
        expect(answerOrNull('Other')).toBeNull();
    });

    test('collapses blanks and absent values to null', () => {
        expect(answerOrNull('   ')).toBeNull();
        expect(answerOrNull(null)).toBeNull();
        expect(answerOrNull(undefined)).toBeNull();
    });
});

describe('splitPicklist', () => {
    test('splits on semicolons and trims, matching the "; " the form emits', () => {
        expect(splitPicklist('Workday; SuccessFactors; SkillJar')).toEqual([
            'Workday',
            'SuccessFactors',
            'SkillJar',
        ]);
    });

    test('drops the "Other" selection', () => {
        expect(
            splitPicklist('Leadership Development; Other; Digital Learning Strategy'),
        ).toEqual(['Leadership Development', 'Digital Learning Strategy']);
    });

    test('accepts an already-split array, and a packed element inside one', () => {
        expect(splitPicklist(['Healthcare;Pharmaceuticals'])).toEqual([
            'Healthcare',
            'Pharmaceuticals',
        ]);
        expect(splitPicklist(['Workday', 'UKG'])).toEqual(['Workday', 'UKG']);
    });

    test('returns an empty array for absent or empty input', () => {
        expect(splitPicklist(null)).toEqual([]);
        expect(splitPicklist(undefined)).toEqual([]);
        expect(splitPicklist('')).toEqual([]);
        expect(splitPicklist(';;')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// The numeric bucketing, which now only applies on the sponsor path.
// ---------------------------------------------------------------------------

describe('formatRevenue / formatCompanySize', () => {
    test('buckets Account numbers into tier strings', () => {
        expect(formatRevenue(5_000_000)).toBe('<10M');
        expect(formatRevenue(6_000_000_000)).toBe('>5B');
        expect(formatCompanySize(250)).toBe('200-500');
        expect(formatCompanySize(99_000)).toBe('>5000');
    });

    test('passes an already-worded string straight through', () => {
        expect(formatRevenue('Under $500M')).toBe('Under $500M');
        expect(formatCompanySize('1,000–5,000')).toBe('1,000–5,000');
    });

    test('returns null for absent values', () => {
        expect(formatRevenue(null)).toBeNull();
        expect(formatCompanySize(null)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// formatProfile — the one normalization pass every source goes through.
// ---------------------------------------------------------------------------

describe('formatProfile', () => {
    test('splits multi-value fields and drops non-answers from every field', () => {
        const out = formatProfile({
            ...emptyProfile(),
            annualRevenue: 'Undisclosed',
            budgetaryResponsibility: 'Undisclosed',
            companySize: '1,000–5,000',
            transformationStage: 'Early planning',
            priorityInitiative: 'Other',
            industrySectors: ['Organization;Advertising/Marketing/PR;Other'],
            interestAreas: ['Leadership Development: Building the Pipeline', 'Other'],
            systemsAndPlatforms: ['Go1; Korn Ferry'],
            meetingInterests: ['Leadership Development'],
        });

        expect(out.annualRevenue).toBeNull();
        expect(out.budgetaryResponsibility).toBeNull();
        expect(out.priorityInitiative).toBeNull();
        expect(out.companySize).toBe('1,000–5,000');
        expect(out.transformationStage).toBe('Early planning');
        expect(out.industrySectors).toEqual([
            'Organization',
            'Advertising/Marketing/PR',
        ]);
        expect(out.interestAreas).toEqual([
            'Leadership Development: Building the Pipeline',
        ]);
        expect(out.systemsAndPlatforms).toEqual(['Go1', 'Korn Ferry']);
    });

    test('is idempotent, so mock and Salesforce data share one pipeline', () => {
        const once = formatProfile({
            ...emptyProfile(),
            industrySectors: ['Healthcare;Pharmaceuticals'],
            interestAreas: ['A; B'],
        });
        expect(formatProfile(once)).toEqual(once);
    });

    test('leaves an entirely unanswered profile untouched', () => {
        expect(formatProfile(emptyProfile())).toEqual(emptyProfile());
    });
});
