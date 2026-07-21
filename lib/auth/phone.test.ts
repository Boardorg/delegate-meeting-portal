import { describe, test, expect } from 'vitest';
import { normalizePhone, toE164 } from './phone';

describe('normalizePhone', () => {
    test('strips formatting without adding a country code', () => {
        expect(normalizePhone('(555) 555-0123')).toBe('5555550123');
        expect(normalizePhone('555-555-0123')).toBe('5555550123');
    });

    test('collapses a redundant US country code to the bare 10-digit number', () => {
        expect(normalizePhone('+15555550123')).toBe('5555550123');
        expect(normalizePhone('15555550123')).toBe('5555550123');
        expect(normalizePhone('5555550123')).toBe('5555550123');
    });

    test('leaves a non-US country code untouched', () => {
        expect(normalizePhone('+44 7700 900123')).toBe('+447700900123');
    });

    test('returns null for input that is not a plausible phone number', () => {
        expect(normalizePhone('abc')).toBeNull();
        expect(normalizePhone('')).toBeNull();
        expect(normalizePhone('12345')).toBeNull();
    });
});

describe('toE164', () => {
    test('adds the default US country code when none is given', () => {
        expect(toE164('5555550123')).toBe('+15555550123');
    });

    test('produces the same E.164 number regardless of how the US country code was entered', () => {
        expect(toE164('+15555550123')).toBe('+15555550123');
        expect(toE164('15555550123')).toBe('+15555550123');
        expect(toE164('5555550123')).toBe('+15555550123');
    });

    test('leaves a non-US country code untouched', () => {
        expect(toE164('+44 7700 900123')).toBe('+447700900123');
    });

    test('returns null for input that is not a plausible phone number', () => {
        expect(toE164('abc')).toBeNull();
    });
});
