import { describe, test, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Module mocks
//
// vi.mock is hoisted above all imports by Vitest, so these run first — the
// route handler receives the fake module, not the real one. This lets us
// test the handler without a real Twilio account, session cookie, or database.
// ---------------------------------------------------------------------------

vi.mock('@/lib/auth/twilio', () => ({ checkVerificationCode: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({ createSession: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ db: { update: vi.fn() } }));

import { POST } from './route';
import { checkVerificationCode } from '@/lib/auth/twilio';
import { createSession } from '@/lib/auth/session';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';

// ---------------------------------------------------------------------------
// Helpers for generating test data
// ---------------------------------------------------------------------------

/**
 * Builds a NextRequest with a JSON body for POST tests.
 *
 * @param {object} body - The JSON body to send.
 * @returns {NextRequest} A POST request to /api/auth/verify with the given body.
 */
function makePostRequest(body: object): NextRequest {
    return new NextRequest('http://localhost/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/**
 * Configures the mocked db.update(...).set(...).where(...).returning() chain
 * to resolve with the given rows. Each step is named so the chain compiles
 * without drizzle's generic types; the route only reaches .returning().
 *
 * @param {object[]} rows - Rows the mocked update should resolve with.
 * @returns {{ setMock: import('vitest').Mock }} The .set() mock, for assertions.
 */
function mockUpdateReturning(rows: object[]) {
    const returningMock = vi.fn().mockResolvedValue(rows);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);
    return { setMock };
}

beforeEach(() => {
    vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('POST /api/auth/verify — body validation', () => {
    test('returns 400 when the body is not valid JSON', async () => {
        const req = new NextRequest('http://localhost/api/auth/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'invalid-json',
        });

        const res = await POST(req);

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'Invalid JSON body' });
        expect(checkVerificationCode).not.toHaveBeenCalled();
    });

    test('returns 400 when contact is missing', async () => {
        const res = await POST(makePostRequest({ code: '123456', channel: 'sms' }));

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'Phone and code are required.' });
        expect(checkVerificationCode).not.toHaveBeenCalled();
    });

    test('returns 400 with an email-specific message when contact is missing on the email channel', async () => {
        const res = await POST(makePostRequest({ code: '123456', channel: 'email' }));

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'Email and code are required.' });
    });

    test('returns 400 when code is missing', async () => {
        const res = await POST(makePostRequest({ contact: '5555550123', channel: 'sms' }));

        expect(res.status).toBe(400);
        expect(checkVerificationCode).not.toHaveBeenCalled();
    });
});

describe('POST /api/auth/verify — Twilio', () => {
    test('returns 502 when checkVerificationCode throws', async () => {
        vi.mocked(checkVerificationCode).mockRejectedValue(new Error('twilio down'));

        const res = await POST(makePostRequest({ contact: '5555550123', channel: 'sms', code: '123456' }));

        expect(res.status).toBe(502);
        expect(createSession).not.toHaveBeenCalled();
    });

    test('returns 401 when the code is not approved', async () => {
        vi.mocked(checkVerificationCode).mockResolvedValue(false);

        const res = await POST(makePostRequest({ contact: '5555550123', channel: 'sms', code: '123456' }));

        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ error: 'Invalid or expired code.' });
        expect(createSession).not.toHaveBeenCalled();
    });
});

describe('POST /api/auth/verify — session + redirect', () => {
    test('creates an sms session keyed on the E.164 phone and redirects non-admins to "/"', async () => {
        vi.mocked(checkVerificationCode).mockResolvedValue(true);
        vi.mocked(createSession).mockResolvedValue(undefined);
        mockUpdateReturning([{ role: 'user' }]);

        const res = await POST(
            makePostRequest({ contact: '+16162833485', channel: 'sms', code: '123456', eventCode: 'PARTY1999' }),
        );
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json).toEqual({ ok: true, redirectTo: '/' });
        expect(checkVerificationCode).toHaveBeenCalledWith('+16162833485', '123456');
        expect(createSession).toHaveBeenCalledWith('6162833485', 'sms', 'PARTY1999');
        expect(vi.mocked(db.update)).toHaveBeenCalledWith(users);
    });

    test('redirects admins to "/admin"', async () => {
        vi.mocked(checkVerificationCode).mockResolvedValue(true);
        vi.mocked(createSession).mockResolvedValue(undefined);
        mockUpdateReturning([{ role: 'admin' }]);

        const res = await POST(makePostRequest({ contact: '5555550123', channel: 'sms', code: '123456' }));
        const json = await res.json();

        expect(json.redirectTo).toBe('/admin');
    });

    test('creates an email session keyed on the normalized email', async () => {
        vi.mocked(checkVerificationCode).mockResolvedValue(true);
        vi.mocked(createSession).mockResolvedValue(undefined);
        const { setMock } = mockUpdateReturning([{ role: 'admin' }]);

        const res = await POST(makePostRequest({ contact: 'Jane@Example.com', channel: 'email', code: '123456' }));
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.redirectTo).toBe('/admin');
        expect(checkVerificationCode).toHaveBeenCalledWith('jane@example.com', '123456');
        expect(createSession).toHaveBeenCalledWith('jane@example.com', 'email', undefined);
        // .set() is called with a lastLogin update regardless of channel.
        expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ lastLogin: expect.anything() }));
    });

    test('still returns ok with redirectTo "/" when no matching user row exists', async () => {
        vi.mocked(checkVerificationCode).mockResolvedValue(true);
        vi.mocked(createSession).mockResolvedValue(undefined);
        mockUpdateReturning([]);

        const res = await POST(makePostRequest({ contact: '5555550123', channel: 'sms', code: '123456' }));
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json).toEqual({ ok: true, redirectTo: '/' });
    });

    test('still returns ok with redirectTo "/" when the DB update throws', async () => {
        vi.mocked(checkVerificationCode).mockResolvedValue(true);
        vi.mocked(createSession).mockResolvedValue(undefined);
        vi.mocked(db.update).mockImplementation(() => {
            throw new Error('db down');
        });

        const res = await POST(makePostRequest({ contact: '5555550123', channel: 'sms', code: '123456' }));
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json).toEqual({ ok: true, redirectTo: '/' });
        // The session is still created even though the last_login update failed.
        expect(createSession).toHaveBeenCalled();
    });
});
