import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { meetingRequests, type MeetingRequestRow } from "@/lib/db/schema";
import { getCurrentIdentity } from "@/lib/auth/currentUser";
import { getEventCode } from "@/lib/helpers/getEventCode";
import { partyId } from "@/lib/attendees/companies";
import type { MeetingRequest } from "@/types";

// ---------------------------------------------------------------------------
// /api/requests — a company's meeting requests for the current event.
//
// The requester is always the logged-in user's PARTY id (their company's
// Salesforce Account id for sponsors, their salesforceId for delegates),
// derived server-side from the resolved identity — never taken from the body,
// so a client can't write requests as someone else. Because sponsors are keyed
// by company, any rep of a company sees and edits the same request set. The
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
    // Requester = the identity's party id (company Account id for sponsors).
    const requesterId = partyId(identity.attendee);
    if (!requesterId) {
        return NextResponse.json(
            { error: "Your account has no company/Salesforce id; cannot save requests." },
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

    // Explicit delete — remove the (requester, target) pair for this event.
    if (body.delete === true) {
        await db
            .delete(meetingRequests)
            .where(
                and(
                    eq(meetingRequests.requesterId, requesterId),
                    eq(meetingRequests.targetId, targetId),
                    eq(meetingRequests.eventCode, eventCode),
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

    // Upsert on the (requester, target, event) unique constraint so re-ranking
    // the same delegate for this event updates the existing row instead of
    // duplicating it. The target columns must match the DB constraint exactly
    // (event_code is part of it, so the same pair can be requested per-event).
    const [row] = await db
        .insert(meetingRequests)
        .values({ requesterId, targetId, rank, eventCode })
        .onConflictDoUpdate({
            target: [
                meetingRequests.requesterId,
                meetingRequests.targetId,
                meetingRequests.eventCode,
            ],
            set: { rank, updatedAt: sql`now()` },
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
    const requesterId = partyId(identity.attendee);
    // No party id → no requests to recall (e.g. an admin viewing the page).
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
