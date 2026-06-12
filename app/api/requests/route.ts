import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { meetingRequests, type MeetingRequestRow } from "@/lib/db/schema";
import { getCurrentIdentity } from "@/lib/auth/currentUser";
import { getEventCode } from "@/lib/helpers/getEventCode";
import type { MeetingRequest } from "@/types";

// ---------------------------------------------------------------------------
// /api/requests — a sponsor's meeting requests for the current event.
//
// The requester is always the logged-in user (their Salesforce id), never
// taken from the body, so a client can't write requests as someone else. The
// target is the delegate's Salesforce id. Rows are scoped to the active event
// code resolved server-side.
//
// Responses speak the shared MeetingRequest shape so the client can key off
// the request id directly.
// ---------------------------------------------------------------------------

/**
 * Projects a DB row onto the shared MeetingRequest type. The serial `id` is
 * stringified to match MeetingRequest.id.
 *
 * @param {MeetingRequestRow} row - A row from the meeting_requests table.
 * @returns {MeetingRequest} The client-facing request shape.
 */
function toMeetingRequest(row: MeetingRequestRow): MeetingRequest {
    return {
        id: String(row.id),
        requesterId: row.requesterId,
        targetId: row.targetId,
        rank: row.rank,
    };
}

/**
 * POST /api/requests — save (upsert) or remove one request.
 *
 * Body: { targetId: string (delegate Salesforce id), rank?: number 1–5, delete?: boolean }.
 * With `delete: true` the (requester, target) pair is removed; otherwise rank
 * 1–5 upserts it.
 *
 * @param {NextRequest} request - Incoming request carrying `{ targetId, rank, delete }`.
 * @returns {Promise<NextResponse>} `{ request: MeetingRequest }` on upsert, `{ ok, deleted }` on delete, 4xx on bad input/auth.
 */
export async function POST(request: NextRequest) {
    const identity = await getCurrentIdentity();
    if (!identity) {
        return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    const requesterId = identity.salesforceId;
    if (!requesterId) {
        return NextResponse.json(
            { error: "Your account has no Salesforce id; cannot save requests." },
            { status: 403 },
        );
    }

    let body: { targetId?: unknown; rank?: unknown; delete?: unknown };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const targetId = typeof body.targetId === "string" ? body.targetId : null;
    if (!targetId) {
        return NextResponse.json(
            { error: "Missing required field: targetId" },
            { status: 400 },
        );
    }

    const eventCode = await getEventCode();

    // Explicit delete — remove the (requester, target) pair if present.
    if (body.delete === true) {
        await db
            .delete(meetingRequests)
            .where(
                and(
                    eq(meetingRequests.requesterId, requesterId),
                    eq(meetingRequests.targetId, targetId),
                ),
            );
        return NextResponse.json({ ok: true, deleted: true });
    }

    const rank = body.rank;
    if (typeof rank !== "number" || rank < 1 || rank > 5) {
        return NextResponse.json(
            { error: "rank must be a number between 1 and 5" },
            { status: 400 },
        );
    }

    // Upsert on the (requester, target) unique constraint so re-ranking the
    // same delegate updates the existing row instead of duplicating it.
    const [row] = await db
        .insert(meetingRequests)
        .values({ requesterId, targetId, rank, eventCode })
        .onConflictDoUpdate({
            target: [meetingRequests.requesterId, meetingRequests.targetId],
            set: { rank, eventCode, updatedAt: sql`now()` },
        })
        .returning();

    return NextResponse.json({ request: toMeetingRequest(row) });
}

/**
 * GET /api/requests — the logged-in sponsor's active requests for the event.
 *
 * @returns {Promise<NextResponse>} `{ requests: MeetingRequest[] }`.
 */
export async function GET() {
    const identity = await getCurrentIdentity();
    if (!identity) {
        return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    const requesterId = identity.salesforceId;
    // No Salesforce id → no requests to recall (e.g. an admin viewing the page).
    if (!requesterId) {
        return NextResponse.json({ requests: [] });
    }

    const eventCode = await getEventCode();
    const rows = await db
        .select()
        .from(meetingRequests)
        .where(
            and(
                eq(meetingRequests.requesterId, requesterId),
                eq(meetingRequests.eventCode, eventCode),
            ),
        );

    return NextResponse.json({ requests: rows.map(toMeetingRequest) });
}
