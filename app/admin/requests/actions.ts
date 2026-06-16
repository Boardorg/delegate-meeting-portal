"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { meetingRequests, type MeetingRequestRow } from "@/lib/db/schema";
import { attendeesBySalesforceId } from "@/lib/attendees/byId";

// ---------------------------------------------------------------------------
// Server actions for the /admin/requests CRUD UI.
//
// Mirrors /admin/users: reads run in the page's server component, mutations
// revalidatePath('/admin/requests') so the table re-renders against fresh
// data. Errors come back as a discriminated result so the row can show them
// inline instead of throwing.
// ---------------------------------------------------------------------------

const PATH = "/admin/requests";

/**
 * Result shape for mutating actions: the saved row on success, or a
 * user-visible message on failure.
 */
export type RequestActionResult =
    | { ok: true; request: MeetingRequestRow }
    | { ok: false; error: string };

/**
 * Maps a DB error to a friendly message, stripping drizzle's "Failed query:"
 * SQL dump and calling out the one unique constraint (requester + target).
 *
 * @param {unknown} err - The thrown error.
 * @returns {string} A message suitable for the admin UI.
 */
function describeDbError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate key|unique/i.test(msg)) {
        return "Error: a request for this requester and target already exists";
    }
    const cleaned = msg.replace(/^Failed query:[\s\S]*/u, "").trim();
    return cleaned ? `Error: ${cleaned}` : "Error: could not save request";
}

/**
 * Validates an interest level (rank). Returns null when valid, else a message.
 */
function rankError(rank: unknown): string | null {
    if (
        typeof rank !== "number" ||
        !Number.isInteger(rank) ||
        rank < 1 ||
        rank > 5
    ) {
        return "Error: interest level must be a whole number between 1 and 5";
    }
    return null;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Returns the distinct event codes present in the requests table, sorted, for
 * the page's event-picker dropdown.
 *
 * @returns {Promise<string[]>} Unique event codes.
 */
export async function listRequestEventCodes(): Promise<string[]> {
    const rows = await db
        .selectDistinct({ eventCode: meetingRequests.eventCode })
        .from(meetingRequests)
        .orderBy(meetingRequests.eventCode);
    return rows.map((r) => r.eventCode);
}

/**
 * One enriched request row: stored fields plus the resolved attendee names.
 * Names come from Salesforce (not the DB), so they're attached here.
 */
export type RequestRow = {
    id: number;
    requesterId: string;
    targetId: string;
    requesterName: string;
    requesterCompany: string;
    targetName: string;
    targetCompany: string;
    rank: number;
    createdAt: Date;
    updatedAt: Date;
};

/** Sortable columns. Name columns sort on the resolved attendee name. */
export type RequestSortField =
    | "requesterName"
    | "targetName"
    | "rank"
    | "createdAt"
    | "updatedAt";

/** Parameters for a single page of requests. `page` is 1-based. */
export type ListRequestsParams = {
    eventCode: string;
    q?: string;
    sortField?: RequestSortField;
    sortDir?: "asc" | "desc";
    page?: number;
    pageSize?: number;
};

/** A page of enriched requests plus the totals the table needs. */
export type RequestsPage = {
    rows: RequestRow[];
    total: number;
    page: number;
    pageSize: number;
    pageCount: number;
};

/**
 * Compares two enriched rows on the given field. Names use locale compare;
 * rank is numeric; timestamps compare by epoch.
 */
function compareRows(
    a: RequestRow,
    b: RequestRow,
    field: RequestSortField,
): number {
    switch (field) {
        case "rank":
            return a.rank - b.rank;
        case "createdAt":
            return a.createdAt.getTime() - b.createdAt.getTime();
        case "updatedAt":
            return a.updatedAt.getTime() - b.updatedAt.getTime();
        case "requesterName":
            return a.requesterName.localeCompare(b.requesterName);
        case "targetName":
            return a.targetName.localeCompare(b.targetName);
    }
}

/**
 * Returns one page of requests for an event, searched and sorted.
 *
 * Requester/target NAMES live in Salesforce, not the DB, so name search and
 * sort can't be expressed in SQL. We load the event's rows (the event filter
 * bounds the set), resolve names, then filter/sort/slice in memory — only the
 * requested page is returned to the client. If a single event ever grows to
 * tens of thousands of requests, denormalize names onto the row (or sort the
 * DB-native columns in SQL) to avoid loading the whole event.
 *
 * @param {ListRequestsParams} params - Event, search, sort, and page.
 * @returns {Promise<RequestsPage>} The page of enriched rows plus totals.
 */
export async function listRequestsPage(
    params: ListRequestsParams,
): Promise<RequestsPage> {
    const pageSize = params.pageSize ?? 25;
    const sortField = params.sortField ?? "updatedAt";
    const sortDir = params.sortDir ?? "desc";
    const q = (params.q ?? "").trim().toLowerCase();

    const [rows, attendees] = await Promise.all([
        db
            .select()
            .from(meetingRequests)
            .where(eq(meetingRequests.eventCode, params.eventCode)),
        attendeesBySalesforceId(params.eventCode),
    ]);

    // Enrich with names + company (falling back to the raw id when unresolved).
    let enriched: RequestRow[] = rows.map((r) => {
        const requester = attendees.get(r.requesterId);
        const target = attendees.get(r.targetId);
        return {
            id: r.id,
            requesterId: r.requesterId,
            targetId: r.targetId,
            requesterName: requester?.name || r.requesterId,
            requesterCompany: requester?.company ?? "",
            targetName: target?.name || r.targetId,
            targetCompany: target?.company ?? "",
            rank: r.rank,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
        };
    });

    if (q) {
        enriched = enriched.filter(
            (r) =>
                r.requesterName.toLowerCase().includes(q) ||
                r.targetName.toLowerCase().includes(q) ||
                r.requesterCompany.toLowerCase().includes(q) ||
                r.targetCompany.toLowerCase().includes(q),
        );
    }

    const dir = sortDir === "asc" ? 1 : -1;
    enriched.sort((a, b) => dir * compareRows(a, b, sortField));

    const total = enriched.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, params.page ?? 1), pageCount);
    const start = (page - 1) * pageSize;

    return {
        rows: enriched.slice(start, start + pageSize),
        total,
        page,
        pageSize,
        pageCount,
    };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Input for createRequest. Ids are Salesforce attendee ids.
 */
export type CreateRequestInput = {
    requesterId: string;
    targetId: string;
    rank: number;
    eventCode: string;
};

/**
 * Inserts a new request. Validates ids/rank/event and surfaces the unique
 * (requester, target) conflict as a friendly error.
 *
 * @param {CreateRequestInput} input - The new request's fields.
 * @returns {Promise<RequestActionResult>} Created row or a friendly error.
 */
export async function createRequest(
    input: CreateRequestInput,
): Promise<RequestActionResult> {
    const requesterId = input.requesterId?.trim();
    const targetId = input.targetId?.trim();
    const eventCode = input.eventCode?.trim();

    if (!requesterId || !targetId) {
        return { ok: false, error: "Error: requester and target are required" };
    }
    if (!eventCode) {
        return { ok: false, error: "Error: event code is required" };
    }
    const rErr = rankError(input.rank);
    if (rErr) return { ok: false, error: rErr };

    try {
        const [request] = await db
            .insert(meetingRequests)
            .values({ requesterId, targetId, rank: input.rank, eventCode })
            .returning();
        revalidatePath(PATH);
        return { ok: true, request };
    } catch (err) {
        return { ok: false, error: describeDbError(err) };
    }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Input for updateRequest. Only the interest level is editable — the
 * requester/target pair identifies the request and isn't changed here.
 */
export type UpdateRequestInput = {
    rank?: number;
};

/**
 * Patches a request's interest level.
 *
 * @param {number} id - The request's primary key.
 * @param {UpdateRequestInput} input - Fields to change.
 * @returns {Promise<RequestActionResult>} Updated row or a friendly error.
 */
export async function updateRequest(
    id: number,
    input: UpdateRequestInput,
): Promise<RequestActionResult> {
    if (input.rank === undefined) {
        return { ok: false, error: "Error: no changes" };
    }
    const rErr = rankError(input.rank);
    if (rErr) return { ok: false, error: rErr };

    try {
        const [request] = await db
            .update(meetingRequests)
            .set({ rank: input.rank, updatedAt: sql`now()` })
            .where(eq(meetingRequests.id, id))
            .returning();
        if (!request) return { ok: false, error: "Error: request not found" };
        revalidatePath(PATH);
        return { ok: true, request };
    } catch (err) {
        return { ok: false, error: describeDbError(err) };
    }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Deletes a request by id. Deleting a missing row is treated as success since
 * the end state matches intent.
 *
 * @param {number} id - The request's primary key.
 * @returns {Promise<{ ok: true } | { ok: false; error: string }>} Result.
 */
export async function deleteRequest(
    id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await db.delete(meetingRequests).where(eq(meetingRequests.id, id));
        revalidatePath(PATH);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: describeDbError(err) };
    }
}
