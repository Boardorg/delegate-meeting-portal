import type { Attendee } from "@/types";
import type { D2DResult, D2DUnmatchedReason } from "./d2d";
import { explainMatch } from "./score";

// ---------------------------------------------------------------------------
// The report shown after a D2D run.
// Pure and serializable, so the server action can return it to the page.
// ---------------------------------------------------------------------------

/** The D2D run report. */
export type D2DReport = {
    eventCode: string;
    generatedAt: string;
    /** Warnings to show above the counts, such as running before S2D. */
    warnings: string[];
    /** Delegates who could be matched. */
    eligible: number;
    /** Delegates left out, by reason. */
    excluded: { conferenceOnly: number; incompleteProfile: number; cancelled: number; seatedAtRoundtable: number };
    /** New D2D meetings this run made. */
    created: number;
    /** Pushed D2D meetings the run kept. */
    kept: number;
    /** Delegates with at least one new meeting. */
    matchedDelegates: number;
    /** New pairs below the minimum score. */
    weak: { label: string; score: number; explanation: string }[];
    /** Eligible delegates with room for a meeting who got none. */
    unmatched: { name: string; company: string; reason: D2DUnmatchedReason }[];
};

/** Plain words for why a delegate went unmatched. */
export const D2D_UNMATCHED_LABEL: Record<D2DUnmatchedReason, string> = {
    no_partner: "No acceptable partner",
    no_slot: "No free slot with a partner",
};

/**
 * Builds the D2D run report.
 *
 * @param {{ eventCode: string; generatedAt: string; attendees: Attendee[]; result: D2DResult; kept: number; warnings: string[] }} params
 *   The event, the run time, the attendees for names, the engine result, how many pushed meetings were kept and any warnings.
 * @returns {D2DReport} The report.
 */
export function buildD2DReport(params: {
    eventCode: string;
    generatedAt: string;
    attendees: Attendee[];
    result: D2DResult;
    kept: number;
    warnings: string[];
}): D2DReport {
    const byId = new Map(params.attendees.map((a) => [a.salesforceId, a]));
    /**
     * A delegate's name, or their id when unknown.
     *
     * @param {string} id - The Salesforce id.
     * @returns {string} The name.
     */
    const name = (id: string): string => byId.get(id)?.name ?? id;
    const { result } = params;
    const excluded = { conferenceOnly: 0, incompleteProfile: 0, cancelled: 0, seatedAtRoundtable: 0 };
    for (const e of result.excluded) {
        if (e.reason === "conference_only") excluded.conferenceOnly++;
        else if (e.reason === "incomplete_profile") excluded.incompleteProfile++;
        else if (e.reason === "seated_at_roundtable") excluded.seatedAtRoundtable++;
        else excluded.cancelled++;
    }
    const matched = new Set(result.meetings.flatMap((m) => [m.attendeeA, m.attendeeB]));
    return {
        eventCode: params.eventCode,
        generatedAt: params.generatedAt,
        warnings: params.warnings,
        eligible: result.eligibleIds.length,
        excluded,
        created: result.meetings.length,
        kept: params.kept,
        matchedDelegates: matched.size,
        weak: result.meetings
            .filter((m) => m.weak)
            .map((m) => ({
                label: `${name(m.attendeeA)} & ${name(m.attendeeB)}`,
                score: m.score,
                explanation: explainMatch(m.shared),
            })),
        unmatched: result.unmatched.map((u) => ({
            name: name(u.delegateId),
            company: byId.get(u.delegateId)?.company ?? "",
            reason: u.reason,
        })),
    };
}
