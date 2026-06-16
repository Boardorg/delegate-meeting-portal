import { describe, test, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { ResolvedIdentity } from '@/types';

// ---------------------------------------------------------------------------
// Module mocks
//
// vi.mock is hoisted above all imports by Vitest, so these run first — the
// route handler receives the fake module, not the real one. This lets us test
// the handler without a real session cookie, event code, or database.
// ---------------------------------------------------------------------------

// Replace the real auth helper (imports server-only, reads session cookies,
// may hit the DB) with a stub we configure per test.
vi.mock('@/lib/auth/currentUser', () => ({ getCurrentIdentity: vi.fn() }));

// Replace the event-code helper (also imports server-only) with a stub.
vi.mock('@/lib/helpers/getEventCode', () => ({ getEventCode: vi.fn() }));

// Replace the drizzle db client (connects to Neon on import) with a stub
// object whose methods we configure per test.
vi.mock('@/lib/db/client', () => ({
    db: { insert: vi.fn(), delete: vi.fn(), select: vi.fn() },
}));

import { POST, GET } from './route';
import { getCurrentIdentity } from '@/lib/auth/currentUser';
import { getEventCode } from '@/lib/helpers/getEventCode';
import { db } from '@/lib/db/client';

// ---------------------------------------------------------------------------
// Helpers for generating test data
// ---------------------------------------------------------------------------

/**
 * Minimal authenticated identity. The route only reads `salesforceId` from
 * this, so the other fields use placeholder values.
 */
const mockIdentity: ResolvedIdentity = {
    phone: '+15555550101',
    role: 'sponsor',
    source: 'salesforce',
    salesforceId: 'sf-requester-001',
    user: null,
    attendee: {} as ResolvedIdentity['attendee'],
};

/**
 * Sample DB row returned after a successful insert or select.
 * Matches the shape of MeetingRequestRow from the schema.
 */
const mockRow = {
    id: 1,
    requesterId: 'sf-requester-001',
    targetId: 'sf-target-001',
    rank: 3,
    eventCode: 'PARTY1999',
    createdAt: new Date(),
    updatedAt: new Date(),
};

/**
 * Builds a NextRequest with a JSON body for POST tests.
 *
 * @param {object} body - The JSON body to send.
 * @returns {NextRequest} A POST request to /api/requests with the given body.
 */
function makePostRequest(body: object): NextRequest {
    return new NextRequest('http://localhost/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

beforeEach(() => {
    // Reset all mock implementations and call histories between tests so
    // nothing leaks from one test into the next.
    vi.resetAllMocks();
    // getEventCode is called on every request that passes auth + body validation.
    // Set a default here so individual tests don't have to repeat it.
    vi.mocked(getEventCode).mockResolvedValue('PARTY1999');
});

// Auth gate runs first. Bad auth should short-circuit before touching the DB.
describe('POST /api/requests — auth', () => {
    test('returns 401 when the user is not authenticated', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(null);

        const res = await POST(makePostRequest({ targetId: 'sf-target-001', rank: 3 }));

        expect(res.status).toBe(401);
    });

    test('returns 403 when the identity has no Salesforce id', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue({ ...mockIdentity, salesforceId: null });

        const res = await POST(makePostRequest({ targetId: 'sf-target-001', rank: 3 }));

        expect(res.status).toBe(403);
    });
});

// Body validation runs after auth. Malformed or incomplete bodies are rejected.
describe('POST /api/requests — body validation', () => {
    test('returns 400 when the body is not valid JSON', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);
        const req = new NextRequest('http://localhost/api/requests', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'invalid-json',
        });

        const res = await POST(req);

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'Invalid JSON body' });
    });

    test('returns 400 when targetId is missing', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);

        const res = await POST(makePostRequest({ rank: 3 }));

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: expect.stringContaining('targetId') });
    });

    test('returns 400 when rank is missing for an upsert request', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);

        const res = await POST(makePostRequest({ targetId: 'sf-target-001' }));

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: expect.stringContaining('rank') });
    });

    test('returns 400 when rank is below the minimum of 1', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);

        const res = await POST(makePostRequest({ targetId: 'sf-target-001', rank: 0 }));

        expect(res.status).toBe(400);
    });

    test('returns 400 when rank is above the maximum of 5', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);

        const res = await POST(makePostRequest({ targetId: 'sf-target-001', rank: 6 }));

        expect(res.status).toBe(400);
    });
});

// Happy paths write to or remove from the DB and return the appropriate shape.
describe('POST /api/requests — DB operations', () => {
    test('deletes the row and returns { ok: true, deleted: true } when delete is true', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);
        // Delete chains: db.delete(table).where(condition)
        // This mock gives db.delete(...) a fake .where(...) method that resolves successfully.
        vi.mocked(db.delete).mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
        } as any);

        const res = await POST(makePostRequest({ targetId: 'sf-target-001', delete: true }));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, deleted: true });
    });

    test('upserts and returns the MeetingRequest on a valid request', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);
        // Upsert chains: db.insert(table).values({}).onConflictDoUpdate({}).returning()
        // Each link returns the next link, and .returning() resolves with the row array.
        vi.mocked(db.insert).mockReturnValue({
            values: vi.fn().mockReturnValue({
                onConflictDoUpdate: vi.fn().mockReturnValue({
                    returning: vi.fn().mockResolvedValue([mockRow]),
                }),
            }),
        } as any);

        const res = await POST(makePostRequest({ targetId: 'sf-target-001', rank: 3 }));
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.request).toMatchObject({
            id: '1', // toMeetingRequest stringifies the serial integer id
            requesterId: 'sf-requester-001',
            targetId: 'sf-target-001',
            rank: 3,
        });
    });
});

// GET returns the caller's own requests for the current event.
describe('GET /api/requests', () => {
    test('returns 401 when the user is not authenticated', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(null);

        const res = await GET();

        expect(res.status).toBe(401);
    });

    test('returns an empty array when the identity has no Salesforce id', async () => {
        // This case represents an admin viewing the page; they have no SF id and
        // therefore no requests to return. The route handles it without hitting the DB.
        vi.mocked(getCurrentIdentity).mockResolvedValue({ ...mockIdentity, salesforceId: null });

        const res = await GET();
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.requests).toEqual([]);
    });

    test('returns the list of requests for the authenticated user', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);
        // Select chains: db.select().from(table).where(condition)
        // Resolves with rows.
        vi.mocked(db.select).mockReturnValue({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([mockRow]),
            }),
        } as any);

        const res = await GET();
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.requests).toHaveLength(1);
        expect(json.requests[0]).toMatchObject({
            id: '1',
            requesterId: 'sf-requester-001',
            targetId: 'sf-target-001',
            rank: 3,
        });
    });

    test('returns an empty array when the user has no requests yet', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);
        vi.mocked(db.select).mockReturnValue({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([]),
            }),
        } as any);

        const res = await GET();
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.requests).toEqual([]);
    });
});
