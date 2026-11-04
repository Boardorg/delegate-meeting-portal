import type { Attendee, Location, Timeslot } from "@/types";
import {
    hostingReps,
    repsBySalesforceId,
    sponsorCompaniesByAccountId,
} from "@/lib/attendees/companies";
import {
    companyMaximumMeetings,
    maximumDiffersFromPackage,
    requestedMeetingsAtOnce,
    type MaximumSource,
} from "@/lib/attendees/caps";
import {
    boothPerSlotLimit,
    resolveCompanyBooths,
    type BoothLocations,
    type BoothMatchSource,
    type BoothProblem,
} from "./booths";

// ---------------------------------------------------------------------------
// Rows for the Sponsor booths admin page.
//
// Pure, so the page's values and warnings can be tested without Salesforce, Cvent or the DB.
// Booth numbers and meeting counts are read-only here. Salesforce stays the place to change them.
// ---------------------------------------------------------------------------

/** One rep on a booths page row. */
export type BoothRowRep = {
    salesforceId: string;
    name: string;
    /** True when the rep has a Cvent contact id and hasn't cancelled. */
    canHost: boolean;
    /** True when the rep's Cvent registration is cancelled. */
    cancelled: boolean;
};

/** One sponsor company on the Sponsor booths page. */
export type BoothRow = {
    accountId: string;
    company: string;
    /** The sponsor Opportunity, for the link to Salesforce. Null when no rep has one. */
    opportunityId: string | null;
    reps: BoothRowRep[];
    /** How many reps can host in Cvent. */
    hostCount: number;
    /** Booth_No__c, trimmed. Null when blank. */
    boothNo: string | null;
    /** The Cvent location the booth resolves to. Null when nothing matches. */
    location: Pick<Location, "id" | "name"> | null;
    /** Whether the location is a manual mapping or the automatic match. Null for "No match". */
    matchSource: BoothMatchSource | null;
    /** The location id in the manual mapping, even when Cvent no longer returns it. */
    manualLocationId: string | null;
    /** The location the automatic match gives. */
    automaticLocation: Pick<Location, "id" | "name"> | null;
    /** The booth's Cvent per-slot limit. Null when the booth has no listed sponsor slot. */
    perSlotLimit: number | null;
    /** Meetings__c. Null when blank. */
    purchased: number | null;
    /** Cvent_Bonus_Meetings__c. Null when blank. */
    bonus: number | null;
    /** Cvent_Maximum_Meetings__c. Null when blank. */
    maximumField: number | null;
    /** The maximum the scheduler uses. */
    maximum: number;
    /** Where the maximum came from. "tier" shows the "from tier" note. */
    maximumSource: MaximumSource;
    /** Cvent_Number_Diaries__c. Null when blank. */
    meetingsAtOnce: number | null;
    /** Every booth or package problem that stops the company's meetings. */
    problems: BoothProblem[];
    /** Plain warnings that don't stop the company's meetings. */
    warnings: string[];
};

/**
 * Builds the warnings for one row.
 * Meetings at once is checked against the booth's Cvent per-slot limit and the reps who can host.
 * Cvent_Maximum_Meetings__c is checked against purchased plus bonus.
 *
 * @param {Omit<BoothRow, "warnings">} row - The row without its warnings.
 * @returns {string[]} The warnings, empty when there are none.
 */
export function boothRowWarnings(row: Omit<BoothRow, "warnings">): string[] {
    const warnings: string[] = [];
    const atOnce = requestedMeetingsAtOnce(row);
    if (row.perSlotLimit !== null && atOnce > row.perSlotLimit) {
        warnings.push(
            `Meetings at once is ${atOnce}, but ${row.location?.name ?? "the booth"} takes only ${row.perSlotLimit} per slot in Cvent.`,
        );
    }
    if (atOnce > row.hostCount) {
        warnings.push(
            `Meetings at once is ${atOnce}, but only ${row.hostCount} ${row.hostCount === 1 ? "rep" : "reps"} can host in Cvent.`,
        );
    }
    if (
        maximumDiffersFromPackage({
            purchasedMeetings: row.purchased,
            bonusMeetings: row.bonus,
            maximumMeetings: row.maximumField,
        })
    ) {
        warnings.push(
            `Cvent maximum is ${row.maximumField}, but purchased plus bonus is ${(row.purchased ?? 0) + (row.bonus ?? 0)}.`,
        );
    }
    return warnings;
}

/**
 * Builds one row per sponsor company for the Sponsor booths page, sorted by company name.
 * Pass every attendee, including cancelled ones, the same as a scheduler run does.
 *
 * @param {Attendee[]} attendees - The event's attendees.
 * @param {Location[]} locations - The event's Cvent locations.
 * @param {Timeslot[]} timeslots - The event's timeslots, for each booth's per-slot limit.
 * @param {BoothLocations | null} mappings - The event's manual booth mapping.
 * @returns {BoothRow[]} The rows.
 */
export function buildBoothRows(
    attendees: Attendee[],
    locations: Location[],
    timeslots: Timeslot[],
    mappings: BoothLocations | null,
): BoothRow[] {
    const companies = [...sponsorCompaniesByAccountId(attendees).values()];
    const booths = resolveCompanyBooths(companies, locations, mappings);
    const rows = companies.map((c) => {
        const booth = booths.get(c.accountId)!;
        const hosts = new Set(hostingReps(c).map((r) => r.salesforceId));
        const max = companyMaximumMeetings(c);
        const row: Omit<BoothRow, "warnings"> = {
            accountId: c.accountId,
            company: c.name,
            opportunityId: c.opportunityId,
            reps: repsBySalesforceId(c.reps).map((r) => ({
                salesforceId: r.salesforceId,
                name: r.name,
                canHost: hosts.has(r.salesforceId),
                cancelled: !!r.cventCancelled,
            })),
            hostCount: hosts.size,
            boothNo: booth.boothNo,
            location: booth.location
                ? { id: booth.location.id, name: booth.location.name }
                : null,
            matchSource: booth.source,
            manualLocationId: booth.manualLocationId,
            automaticLocation: booth.automaticLocation
                ? { id: booth.automaticLocation.id, name: booth.automaticLocation.name }
                : null,
            perSlotLimit: boothPerSlotLimit(booth.location?.id, timeslots),
            purchased: c.purchasedMeetings,
            bonus: c.bonusMeetings,
            maximumField: c.maximumMeetings,
            maximum: max.maximum,
            maximumSource: max.source,
            meetingsAtOnce: c.meetingsAtOnce,
            problems: [...booth.problems],
        };
        return { ...row, warnings: boothRowWarnings(row) };
    });
    return rows.sort((a, b) => a.company.localeCompare(b.company));
}
