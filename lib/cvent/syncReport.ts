// ---------------------------------------------------------------------------
// Cvent sync report
//
// A pure, side-effect-free summary of a push-to-Cvent run, built from the
// per-meeting push outcomes plus the event's overall meeting counts. Like the
// scheduler report, the shape is flat and fully JSON-serializable (string
// enums, ISO dates) so it can be returned to the client today and persisted
// later. This module has no `server-only` guard and imports nothing from
// push.ts, so it's safe to unit-test and to import types from on the client.
// ---------------------------------------------------------------------------

/**
 * Why a single meeting failed to sync to Cvent. A closed set of stable codes,
 * each mapping to an actionable explanation in the UI.
 *
 * Resolved locally, before any Cvent call:
 * - missing_timeslot: the meeting's timeslot no longer exists in Cvent.
 * - missing_location: the meeting has no location assigned to send.
 * - host_not_in_cvent: the requester (appointment host) has no Cvent contact id.
 *
 * Returned by Cvent when the appointment was rejected:
 * - cvent_no_availability: host has no free appointment slot at that time (409).
 * - cvent_validation: Cvent rejected the appointment data (400 / 422).
 * - cvent_conflict: a conflicting appointment / duplicate code (409).
 * - cvent_not_found: a referenced entity wasn't found in Cvent (404).
 * - cvent_auth: the Cvent credentials are invalid or lack permission (401/403).
 * - cvent_rate_limited: Cvent throttled the request (429).
 * - cvent_server_error: Cvent had an internal error (5xx).
 *
 * Transport / catch-all:
 * - network_error: the request never reached Cvent (DNS, timeout, TLS).
 * - unknown: an unrecognized error; see the attached detail.
 */
export type SyncFailureReason =
    | "missing_timeslot"
    | "missing_location"
    | "host_not_in_cvent"
    | "cvent_no_availability"
    | "cvent_validation"
    | "cvent_conflict"
    | "cvent_not_found"
    | "cvent_auth"
    | "cvent_rate_limited"
    | "cvent_server_error"
    | "network_error"
    | "unknown";

/** Whether a push created a new appointment or replaced an existing one. */
export type SyncKind = "create" | "update";

/**
 * The per-meeting outcome the report is built from. `push.ts`'s PushResult
 * extends this, so a PushSummary's results array is a valid input without any
 * import from push.ts (avoiding a server-only dependency here).
 */
export interface MeetingSyncOutcome {
    meetingId: string;
    label: string;
    ok: boolean;
    /** Whether this was a create or an update attempt. */
    kind: SyncKind;
    /** Categorized reason, set when `ok` is false. */
    reason?: SyncFailureReason;
    /** Technical detail (Cvent message / validation output), set on failure. */
    error?: string;
    /** Non-fatal note on an otherwise-successful push (e.g. cleanup issue). */
    warning?: string;
}

/** One failed meeting, as surfaced in the report. */
export interface SyncFailure {
    meetingId: string;
    label: string;
    reason: SyncFailureReason;
    /** Technical detail behind the categorized reason. */
    detail: string;
}

/** One successful-but-noteworthy meeting. */
export interface SyncWarning {
    meetingId: string;
    label: string;
    detail: string;
}

/** Full push-run summary. Flat and JSON-serializable — no Dates or Maps. */
export interface SyncReport {
    eventCode: string;
    /** ISO 8601 timestamp of when the report was generated. */
    generatedAt: string;
    /** All portal meetings for the event (the sync's universe). */
    totalPortalMeetings: number;
    /** Portal meetings already synced and up to date — not attempted. */
    alreadySynced: number;
    /** Meetings a push was attempted for (new + modified). */
    attempted: number;
    /** Successful new appointments. */
    created: number;
    /** Successful replacements of a modified meeting. */
    updated: number;
    /** created + updated. */
    succeeded: number;
    /** Number of failed attempts. */
    failed: number;
    failures: SyncFailure[];
    warnings: SyncWarning[];
}

/** Inputs for {@link buildSyncReport}. */
export interface BuildSyncReportArgs {
    eventCode: string;
    /** ISO timestamp; passed in so the builder stays pure/deterministic. */
    generatedAt: string;
    totalPortalMeetings: number;
    alreadySynced: number;
    /** Per-meeting outcomes from the push (PushSummary.results). */
    results: MeetingSyncOutcome[];
}

/**
 * Parses Cvent's JSON error body into its message and code. Cvent error
 * responses look like `{ "message": "...", "code": "NO_MORE_APPT..." }`; either
 * field may be absent or the body may not be JSON.
 *
 * @param {unknown} body - The raw response body (a string on SDK errors).
 * @returns {{ message: string | null; code: string | null }} Extracted fields.
 */
export function parseCventError(body: unknown): {
    message: string | null;
    code: string | null;
} {
    if (typeof body !== "string" || !body.trim()) {
        return { message: null, code: null };
    }
    try {
        const parsed = JSON.parse(body) as { message?: unknown; code?: unknown };
        return {
            message:
                typeof parsed.message === "string" && parsed.message.trim()
                    ? parsed.message.trim()
                    : null,
            code:
                typeof parsed.code === "string" && parsed.code.trim()
                    ? parsed.code.trim()
                    : null,
        };
    } catch {
        return { message: null, code: null };
    }
}

/**
 * Classifies a thrown Cvent push error into a {@link SyncFailureReason}, so the
 * UI can show an actionable explanation. Duck-typed against the Cvent SDK error
 * shape (`statusCode` + JSON `body`) rather than its classes.
 *
 * @param {unknown} err - The thrown error from a create/cancel call.
 * @returns {SyncFailureReason} The categorized reason.
 */
export function classifyPushError(err: unknown): SyncFailureReason {
    if (!(err instanceof Error)) return "unknown";

    const e = err as { statusCode?: number; body?: string };
    const status = e.statusCode;
    const { code } = parseCventError(e.body);

    // No HTTP status usually means the request never completed — a transport
    // failure rather than a Cvent rejection.
    if (typeof status !== "number") {
        if (
            /fetch failed|network|socket|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed? ?out/i.test(
                err.message,
            )
        ) {
            return "network_error";
        }
        return "unknown";
    }

    if (status === 401 || status === 403) return "cvent_auth";
    if (status === 404) return "cvent_not_found";
    if (status === 429) return "cvent_rate_limited";
    if (status === 409) {
        // Cvent uses distinct codes for "host is full at this time" vs a plain
        // conflict; the former is the common, actionable one for admins.
        if (code && /NO_MORE_APPT|NO_APPT|AVAIL|FULL|CAPACITY/i.test(code)) {
            return "cvent_no_availability";
        }
        return "cvent_conflict";
    }
    if (status === 400 || status === 422) return "cvent_validation";
    if (status >= 500) return "cvent_server_error";
    return "unknown";
}

/**
 * Builds a serializable summary of a push-to-Cvent run from the per-meeting
 * outcomes and the event's meeting counts.
 *
 * @param {BuildSyncReportArgs} args - Counts plus the push results.
 * @returns {SyncReport} A flat, serializable sync report.
 */
export function buildSyncReport(args: BuildSyncReportArgs): SyncReport {
    const { eventCode, generatedAt, totalPortalMeetings, alreadySynced, results } =
        args;

    const created = results.filter((r) => r.ok && r.kind === "create").length;
    const updated = results.filter((r) => r.ok && r.kind === "update").length;

    const failures: SyncFailure[] = results
        .filter((r) => !r.ok)
        .map((r) => ({
            meetingId: r.meetingId,
            label: r.label,
            reason: r.reason ?? "unknown",
            detail: r.error ?? "Unknown error",
        }));

    const warnings: SyncWarning[] = results
        .filter((r) => r.ok && r.warning)
        .map((r) => ({
            meetingId: r.meetingId,
            label: r.label,
            detail: r.warning!,
        }));

    return {
        eventCode,
        generatedAt,
        totalPortalMeetings,
        alreadySynced,
        attempted: results.length,
        created,
        updated,
        succeeded: created + updated,
        failed: failures.length,
        failures,
        warnings,
    };
}
