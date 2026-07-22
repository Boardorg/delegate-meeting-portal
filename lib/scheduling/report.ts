import { Attendee, MeetingRequest, ScheduledMeeting } from "@/types";
import { pairKey } from "./helpers";

// ---------------------------------------------------------------------------
// Scheduler run report
//
// A pure, side-effect-free summary of a scheduling run, built from the engine's
// output plus the post-run reconciliation. The shape is deliberately flat and
// fully JSON-serializable (string enums, ISO dates, plain arrays/records) so it
// can be returned from a server action to the client today and persisted to the
// database unchanged later. This module imports nothing from the engine, so the
// engine can import the SchedulerFailureReason type from here without a cycle.
// ---------------------------------------------------------------------------

/**
 * Why a requested meeting was not scheduled. A closed set of stable string
 * codes so the value is safe to store and to switch on in the UI.
 *
 * The engine *attempted* the pair but couldn't place it:
 * - cap_reached: an attendee had already hit their per-day meeting cap.
 * - no_availability: no timeslot left where both parties were free.
 * - company_diversity: scheduling it would break the same-company meeting limit.
 *
 * The engine never attempted the pair (rejected during candidate collection):
 * - self_request: the request targets the requester themselves.
 * - not_an_attendee: requester and/or target isn't in the attendee list.
 * - no_pass_match: a valid pair that matched none of the scheduling passes'
 *   role/rank/mutuality filters (e.g. a low-interest delegate→sponsor request,
 *   or a sponsor→sponsor request), so it was never a candidate.
 *
 * Placed then dropped:
 * - conflict_existing: engine scheduled it, but reconciliation dropped it for
 *   conflicting with an already-pushed/Cvent meeting.
 */
export type SchedulerFailureReason =
    | "cap_reached"
    | "no_availability"
    | "company_diversity"
    | "self_request"
    | "not_an_attendee"
    | "no_pass_match"
    | "conflict_existing";

/** A single request that did not result in a scheduled meeting. */
export interface UnscheduledRequest {
    requesterId: string;
    requesterName: string;
    targetId: string;
    targetName: string;
    rank: number;
    reason: SchedulerFailureReason;
}

/** Scheduled-vs-unscheduled request counts for one interest level (rank). */
export interface InterestLevelBreakdown {
    level: number;
    scheduled: number;
    unscheduled: number;
}

/** Full run summary. Flat and JSON-serializable — no Maps, Sets, or Dates. */
export interface SchedulerReport {
    eventCode: string;
    /** ISO 8601 timestamp of when the report was generated. */
    generatedAt: string;
    sponsorsConsidered: number;
    requestsConsidered: number;
    meetingsScheduled: number;
    /** How many scheduled meetings were mutual (both parties requested). */
    mutualMeetings: number;
    /** Request-centric tally per interest level (1..5). */
    byInterestLevel: InterestLevelBreakdown[];
    /** Meetings scheduled per engine pass, keyed by pass number. */
    meetingsByPass: Record<number, number>;
    unscheduledRequests: UnscheduledRequest[];
}

/** Inputs for {@link buildSchedulerReport}. */
export interface BuildReportArgs {
    eventCode: string;
    /** ISO timestamp; passed in so this builder stays pure/deterministic. */
    generatedAt: string;
    attendees: Attendee[];
    requests: MeetingRequest[];
    /** The final, reconciled set of meetings actually kept. */
    reconciled: ScheduledMeeting[];
    /** Why each attempted pair was skipped by the engine, keyed by pairKey. */
    skipReasons: Map<string, SchedulerFailureReason>;
    /** Pairs the engine scheduled but reconciliation later dropped, keyed by pairKey. */
    reconciledOutPairs: Set<string>;
}

// Interest levels the chart always shows a bar for, lowest to highest.
const INTEREST_LEVELS = [1, 2, 3, 4, 5] as const;

/**
 * Builds a DB-friendly summary of a scheduling run.
 *
 * The tally is request-centric: every request counts under its own rank, so a
 * mutual meeting is counted once for each side's request and the summed green
 * counts can exceed `meetingsScheduled` — that's expected.
 *
 * @param {BuildReportArgs} args - Engine output plus reconciliation context.
 * @returns {SchedulerReport} A flat, serializable run report.
 */
export function buildSchedulerReport(args: BuildReportArgs): SchedulerReport {
    const {
        eventCode,
        generatedAt,
        attendees,
        requests,
        reconciled,
        skipReasons,
        reconciledOutPairs,
    } = args;

    // Name lookup for rendering the unscheduled list without extra queries.
    const nameById = new Map(attendees.map((a) => [a.salesforceId, a.name]));

    // The pairs that survived reconciliation — a request is "scheduled" iff its
    // canonical pair is among these.
    const finalPairs = new Set(
        reconciled.map((m) => pairKey(m.attendeeA, m.attendeeB)),
    );

    // Seed per-level counters so every level 1..5 renders even at zero.
    const levelTally = new Map<number, InterestLevelBreakdown>(
        INTEREST_LEVELS.map((level) => [
            level,
            { level, scheduled: 0, unscheduled: 0 },
        ]),
    );

    const unscheduledRequests: UnscheduledRequest[] = [];

    for (const req of requests) {
        const pair = pairKey(req.requesterId, req.targetId);
        const scheduled = finalPairs.has(pair);

        // Clamp rank into the tracked 1..5 range; anything outside falls in the
        // nearest bucket rather than being silently dropped from the chart.
        const level = Math.min(5, Math.max(1, req.rank));
        const bucket = levelTally.get(level)!;
        if (scheduled) {
            bucket.scheduled += 1;
        } else {
            bucket.unscheduled += 1;
            unscheduledRequests.push({
                requesterId: req.requesterId,
                requesterName: nameById.get(req.requesterId) ?? req.requesterId,
                targetId: req.targetId,
                targetName: nameById.get(req.targetId) ?? req.targetId,
                rank: req.rank,
                reason: classifyUnscheduled(req, {
                    nameById,
                    reconciledOutPairs,
                    skipReasons,
                    pair,
                }),
            });
        }
    }

    // Meetings per engine pass, for an at-a-glance sense of where slots filled.
    const meetingsByPass: Record<number, number> = {};
    for (const m of reconciled) {
        meetingsByPass[m.passNumber] = (meetingsByPass[m.passNumber] ?? 0) + 1;
    }

    // Sort unscheduled: highest interest first, then by requester name.
    unscheduledRequests.sort(
        (a, b) =>
            b.rank - a.rank || a.requesterName.localeCompare(b.requesterName),
    );

    return {
        eventCode,
        generatedAt,
        sponsorsConsidered: attendees.filter((a) => a.role === "sponsor").length,
        requestsConsidered: requests.length,
        meetingsScheduled: reconciled.length,
        mutualMeetings: reconciled.filter((m) => m.mutual).length,
        byInterestLevel: INTEREST_LEVELS.map((level) => levelTally.get(level)!),
        meetingsByPass,
        unscheduledRequests,
    };
}

/**
 * Determines why a single unscheduled request failed, in precedence order:
 * dropped-in-reconciliation → engine-recorded skip → collection-phase reason
 * (self-request / non-attendee / no matching pass). The last three mirror the
 * `continue` branches the engine takes while collecting candidates, before any
 * skip reason is recorded — so they're reconstructed here from the request and
 * attendee data rather than reported by the engine.
 *
 * @param {MeetingRequest} req - The unscheduled request.
 * @param {object} ctx - Lookups: attendee names, dropped pairs, engine skips, and this request's pairKey.
 * @returns {SchedulerFailureReason} The classified reason.
 */
function classifyUnscheduled(
    req: MeetingRequest,
    ctx: {
        nameById: Map<string, string>;
        reconciledOutPairs: Set<string>;
        skipReasons: Map<string, SchedulerFailureReason>;
        pair: string;
    },
): SchedulerFailureReason {
    const { nameById, reconciledOutPairs, skipReasons, pair } = ctx;

    // Placed by the engine, then dropped for conflicting with a pushed meeting.
    if (reconciledOutPairs.has(pair)) return "conflict_existing";

    // The engine attempted the pair but couldn't place it (cap / availability /
    // company diversity).
    const skip = skipReasons.get(pair);
    if (skip) return skip;

    // Never attempted — reconstruct the candidate-collection rejection. A
    // self-request is checked first as the most specific case, then whether
    // both parties are known attendees; anything else is a valid pair that
    // simply matched none of the scheduling passes.
    if (req.requesterId === req.targetId) return "self_request";
    if (!nameById.has(req.requesterId) || !nameById.has(req.targetId)) {
        return "not_an_attendee";
    }
    return "no_pass_match";
}
