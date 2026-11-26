import type { Attendee, Location } from "@/types";
import type { RoundtableResult } from "./roundtables";

// ---------------------------------------------------------------------------
// The report shown after a roundtable run.
// Pure and serializable, so the server action can return it to the page.
// ---------------------------------------------------------------------------

/** One table in the roundtable report. */
export type RoundtableReportTable = {
    /** The table's location name. */
    label: string;
    startTime: string;
    seated: number;
    seats: number;
    alternates: number;
    summary: string;
    averageScore: number;
    short: boolean;
    weak: boolean;
};

/** The roundtable run report. */
export type RoundtableReport = {
    eventCode: string;
    generatedAt: string;
    /** Warnings to show above the counts, such as running before D2D. */
    warnings: string[];
    tables: RoundtableReportTable[];
    /** Delegates who could be seated. */
    eligible: number;
    /** Delegates left out, by reason. */
    excluded: { hasMeetings: number; conferenceOnly: number; cancelled: number };
    /** Eligible delegates neither seated nor an alternate. */
    unassigned: { name: string; company: string }[];
    /** Pushed tables the run left alone. */
    kept: number;
};

/**
 * Builds the roundtable run report.
 *
 * @param {{ eventCode: string; generatedAt: string; attendees: Attendee[]; locationById: Map<string, Location>; result: RoundtableResult; seats: number; kept: number; warnings: string[] }} params
 *   The event, the run time, attendees and locations for names, the engine result, seats per table, pushed tables kept and warnings.
 * @returns {RoundtableReport} The report.
 */
export function buildRoundtableReport(params: {
    eventCode: string;
    generatedAt: string;
    attendees: Attendee[];
    locationById: Map<string, Location>;
    result: RoundtableResult;
    seats: number;
    kept: number;
    warnings: string[];
}): RoundtableReport {
    const byId = new Map(params.attendees.map((a) => [a.salesforceId, a]));
    const excluded = { hasMeetings: 0, conferenceOnly: 0, cancelled: 0 };
    for (const e of params.result.excluded) {
        if (e.reason === "has_meetings") excluded.hasMeetings++;
        else if (e.reason === "conference_only") excluded.conferenceOnly++;
        else excluded.cancelled++;
    }
    return {
        eventCode: params.eventCode,
        generatedAt: params.generatedAt,
        warnings: params.warnings,
        tables: params.result.groups.map((g) => ({
            label: (g.locationId ? params.locationById.get(g.locationId)?.name : undefined) ?? "Unknown location",
            startTime: g.startTime,
            seated: g.seated.length,
            seats: params.seats,
            alternates: g.alternates.length,
            summary: g.summary,
            averageScore: g.averageScore,
            short: g.short,
            weak: g.weak,
        })),
        eligible: params.result.eligibleIds.length,
        excluded,
        unassigned: params.result.unassigned.map((id) => ({
            name: byId.get(id)?.name ?? id,
            company: byId.get(id)?.company ?? "",
        })),
        kept: params.kept,
    };
}
