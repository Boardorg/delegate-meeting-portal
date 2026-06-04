import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/requests
 *
 * Saves a single meeting request from a sponsor to a delegate.
 *
 * Body: { requesterId: string, targetId: string, rank: number (1–5) }
 *
 * Upserts: submitting the same requesterId+targetId pair with a new rank
 * replaces the previous entry. Submitting with rank 0 removes the request.
 *
 * TODO: persist to database.
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { requesterId, targetId, rank } = body;

        if (!requesterId || !targetId) {
            return NextResponse.json(
                { error: 'Missing required fields: requesterId, targetId' },
                { status: 400 },
            );
        }

        if (typeof rank !== 'number' || rank < 0 || rank > 5) {
            return NextResponse.json(
                { error: 'rank must be a number between 0 and 5' },
                { status: 400 },
            );
        }

        return NextResponse.json({ ok: true, requesterId, targetId, rank });
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
}
