import { describe, test, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { ResolvedIdentity } from '@/types';

// ---------------------------------------------------------------------------
// Module mocks
//
// vi.mock is hoisted above all imports by Vitest, so these run first — the
// route handler receives the fake module, not the real one. This lets us
// test the handler without a real Twilio account or database.
// ---------------------------------------------------------------------------

vi.mock('@/lib/auth/twilio', () => ({ sendVerificationCode: vi.fn() }));
vi.mock('@/lib/auth/identity', () => ({ resolveIdentity: vi.fn() }));

import { POST } from './route';
import { sendVerificationCode } from '@/lib/auth/twilio';
import { resolveIdentity } from '@/lib/auth/identity';

// ---------------------------------------------------------------------------
// Helpers for generating test data
// ---------------------------------------------------------------------------

/**
 * Minimal resolved identity. The route only checks truthiness of the
 * resolveIdentity result, so the field values here are placeholders.
 */
const mockIdentity: ResolvedIdentity = {
    contact: '+15555550123',
    channel: 'sms',
    role: 'user',
    source: 'users',
    salesforceId: null,
    user: null,
    attendee: {} as ResolvedIdentity['attendee'],
};

/**
 * Builds a NextRequest with a JSON body for POST tests.
 *
 * @param {object} body - The JSON body to send.
 * @returns {NextRequest} A POST request to /api/auth/login with the given body.
 */
function makePostRequest(body: object): NextRequest {
    return new NextRequest('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('POST /api/auth/login — body validation', () => {
    test('returns 400 when the body is not valid JSON', async () => {
        const req = new NextRequest('http://localhost/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'invalid-json',
        });

        const res = await POST(req);

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'Invalid JSON body' });
        expect(resolveIdentity).not.toHaveBeenCalled();
        expect(sendVerificationCode).not.toHaveBeenCalled();
    });

    test('returns 400 with a phone-specific message when contact is not a valid phone', async () => {
        const res = await POST(makePostRequest({ contact: 'abc', channel: 'sms' }));

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'A valid phone number is required.' });
        expect(resolveIdentity).not.toHaveBeenCalled();
    });

    test('returns 400 with an email-specific message when contact is not a valid email', async () => {
        const res = await POST(makePostRequest({ contact: 'not-an-email', channel: 'email' }));

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'A valid email address is required.' });
        expect(resolveIdentity).not.toHaveBeenCalled();
    });

    test('defaults to the sms channel when channel is omitted', async () => {
        vi.mocked(resolveIdentity).mockResolvedValue(mockIdentity);
        vi.mocked(sendVerificationCode).mockResolvedValue(undefined);

        const res = await POST(makePostRequest({ contact: '5555550123' }));

        expect(res.status).toBe(200);
        expect(resolveIdentity).toHaveBeenCalledWith('5555550123', 'sms', undefined);
    });
});

describe('POST /api/auth/login — identity resolution', () => {
    test('returns 403 with a phone-specific message when the phone is not recognized', async () => {
        vi.mocked(resolveIdentity).mockResolvedValue(null);

        const res = await POST(makePostRequest({ contact: '5555550123', channel: 'sms' }));

        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: expect.stringContaining('phone number') });
        expect(sendVerificationCode).not.toHaveBeenCalled();
    });

    test('returns 403 with an email-specific message when the email is not recognized', async () => {
        vi.mocked(resolveIdentity).mockResolvedValue(null);

        const res = await POST(makePostRequest({ contact: 'jane@example.com', channel: 'email' }));

        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: expect.stringContaining('email address') });
        expect(sendVerificationCode).not.toHaveBeenCalled();
    });

    test('returns 502 when resolveIdentity throws', async () => {
        vi.mocked(resolveIdentity).mockRejectedValue(new Error('db down'));

        const res = await POST(makePostRequest({ contact: '5555550123', channel: 'sms' }));

        expect(res.status).toBe(502);
        expect(sendVerificationCode).not.toHaveBeenCalled();
    });
});

describe('POST /api/auth/login — Twilio', () => {
    test('returns 502 when sendVerificationCode throws', async () => {
        vi.mocked(resolveIdentity).mockResolvedValue(mockIdentity);
        vi.mocked(sendVerificationCode).mockRejectedValue(new Error('twilio down'));

        const res = await POST(makePostRequest({ contact: '5555550123', channel: 'sms' }));

        expect(res.status).toBe(502);
    });

    test('sends an E.164 phone via the sms channel and echoes the DB-canonical phone', async () => {
        vi.mocked(resolveIdentity).mockResolvedValue(mockIdentity);
        vi.mocked(sendVerificationCode).mockResolvedValue(undefined);

        const res = await POST(
            makePostRequest({ contact: '+16162833485', channel: 'sms', eventCode: 'PARTY1999' }),
        );
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json).toEqual({ contact: '6162833485', channel: 'sms' });
        expect(resolveIdentity).toHaveBeenCalledWith('6162833485', 'sms', 'PARTY1999');
        expect(sendVerificationCode).toHaveBeenCalledWith('+16162833485', 'sms');
    });

    test('sends the normalized email via the email channel', async () => {
        vi.mocked(resolveIdentity).mockResolvedValue(mockIdentity);
        vi.mocked(sendVerificationCode).mockResolvedValue(undefined);

        const res = await POST(makePostRequest({ contact: ' Jane@Example.com ', channel: 'email' }));
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json).toEqual({ contact: 'jane@example.com', channel: 'email' });
        expect(resolveIdentity).toHaveBeenCalledWith('jane@example.com', 'email', undefined);
        expect(sendVerificationCode).toHaveBeenCalledWith('jane@example.com', 'email');
    });
});
