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
import { meetingRequests } from '@/lib/db/schema';

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
        expect(getEventCode).not.toHaveBeenCalled();
        expect(db.insert).not.toHaveBeenCalled();
        expect(db.delete).not.toHaveBeenCalled();
    });

    test('returns 403 when the identity has no Salesforce id', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue({ ...mockIdentity, salesforceId: null });

        const res = await POST(makePostRequest({ targetId: 'sf-target-001', rank: 3 }));

        expect(res.status).toBe(403);
        expect(getEventCode).not.toHaveBeenCalled();
        expect(db.insert).not.toHaveBeenCalled();
        expect(db.delete).not.toHaveBeenCalled();
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
        expect(getEventCode).not.toHaveBeenCalled();
        expect(db.insert).not.toHaveBeenCalled();
        expect(db.delete).not.toHaveBeenCalled();
    });

    test('returns 400 when targetId is missing', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);

        const res = await POST(makePostRequest({ rank: 3 }));

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: expect.stringContaining('targetId') });
        expect(getEventCode).not.toHaveBeenCalled();
        expect(db.insert).not.toHaveBeenCalled();
        expect(db.delete).not.toHaveBeenCalled();
    });

    test('returns 400 when targetId is not a string', async () => {
        // The route coerces non-string targetId to null and rejects it.
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);

        const res = await POST(makePostRequest({ targetId: 123, rank: 3 }));

        expect(res.status).toBe(400);
        expect(getEventCode).not.toHaveBeenCalled();
        expect(db.insert).not.toHaveBeenCalled();
        expect(db.delete).not.toHaveBeenCalled();
    });

    test('returns 400 when rank is missing for an upsert request', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);

        const res = await POST(makePostRequest({ targetId: 'sf-target-001' }));

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: expect.stringContaining('rank') });
        expect(db.insert).not.toHaveBeenCalled();
        expect(db.delete).not.toHaveBeenCalled();
    });

    test('returns 400 when rank is a string instead of a number', async () => {
        // Form-style or careless clients may send rank as "3" rather than 3.
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);

        const res = await POST(makePostRequest({ targetId: 'sf-target-001', rank: '3' }));

        expect(res.status).toBe(400);
        expect(db.insert).not.toHaveBeenCalled();
        expect(db.delete).not.toHaveBeenCalled();
    });

    test('returns 400 when rank is below the minimum of 1', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);

        const res = await POST(makePostRequest({ targetId: 'sf-target-001', rank: 0 }));

        expect(res.status).toBe(400);
        expect(db.insert).not.toHaveBeenCalled();
        expect(db.delete).not.toHaveBeenCalled();
    });

    test('returns 400 when rank is above the maximum of 5', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);

        const res = await POST(makePostRequest({ targetId: 'sf-target-001', rank: 6 }));

        expect(res.status).toBe(400);
        expect(db.insert).not.toHaveBeenCalled();
        expect(db.delete).not.toHaveBeenCalled();
    });
});

// Happy paths write to or remove from the DB and return the appropriate shape.
describe('POST /api/requests — DB operations', () => {
    test('deletes the row and returns { ok: true, deleted: true } when delete is true', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);
        // Build the mock delete chain: db.delete(table).where(condition)
        const whereMock = vi.fn().mockResolvedValue(undefined);
        vi.mocked(db.delete).mockReturnValue({ where: whereMock } as any);

        const res = await POST(makePostRequest({ targetId: 'sf-target-001', delete: true }));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, deleted: true });
        expect(vi.mocked(db.delete)).toHaveBeenCalledWith(meetingRequests);
        expect(whereMock).toHaveBeenCalled();
    });

    test('upserts and returns the MeetingRequest on a valid request', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);
        // Build mock upsert chain: db.insert(table).values({}).onConflictDoUpdate({}).returning()
        // Each step is named so we can assert on the arguments passed to it.
        const returningMock = vi.fn().mockResolvedValue([mockRow]);
        const onConflictDoUpdateMock = vi.fn().mockReturnValue({ returning: returningMock });
        const valuesMock = vi.fn().mockReturnValue({ onConflictDoUpdate: onConflictDoUpdateMock });
        vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as any);

        const res = await POST(makePostRequest({ targetId: 'sf-target-001', rank: 3 }));
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.request).toMatchObject({
            id: '1', // toMeetingRequest stringifies the serial integer id
            requesterId: 'sf-requester-001',
            targetId: 'sf-target-001',
            rank: 3,
        });
        expect(vi.mocked(db.insert)).toHaveBeenCalledWith(meetingRequests);
        expect(valuesMock).toHaveBeenCalledWith({
            requesterId: 'sf-requester-001',
            targetId: 'sf-target-001',
            rank: 3,
            eventCode: 'PARTY1999',
        });
    });
});

// GET returns the caller's own requests for the current event.
describe('GET /api/requests', () => {
    test('returns 401 when the user is not authenticated', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(null);

        const res = await GET();

        expect(res.status).toBe(401);
        expect(getEventCode).not.toHaveBeenCalled();
        expect(db.select).not.toHaveBeenCalled();
    });

    test('returns an empty array when the identity has no Salesforce id', async () => {
        // This case represents an admin viewing the page; they have no SF id and
        // therefore no requests to return. The route handles it without hitting the DB.
        vi.mocked(getCurrentIdentity).mockResolvedValue({ ...mockIdentity, salesforceId: null });

        const res = await GET();
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.requests).toEqual([]);
        expect(db.select).not.toHaveBeenCalled();
    });

    test('returns the list of requests for the authenticated user', async () => {
        vi.mocked(getCurrentIdentity).mockResolvedValue(mockIdentity);
        // Build mock select chain: db.select().from(table).where(condition)
        const whereMock = vi.fn().mockResolvedValue([mockRow]);
        const fromMock = vi.fn().mockReturnValue({ where: whereMock });
        vi.mocked(db.select).mockReturnValue({ from: fromMock } as any);

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
        expect(fromMock).toHaveBeenCalledWith(meetingRequests);
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
