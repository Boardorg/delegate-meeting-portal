import type { EventSettingsRow } from "@/lib/db/schema";
import { kindForAppointmentType, type AppointmentTypeKinds } from "@/lib/events/meetingKinds";
import { getSyncStatus, type SyncFields } from "@/lib/cvent/syncStatus";

// ---------------------------------------------------------------------------
// The counts and warnings on the admin Overview page.
//
// The Overview follows the scheduling order for the selected event.
// These helpers turn data the other admin pages already load into card counts.
// Pure, so they can be tested without the database or Cvent.
// ---------------------------------------------------------------------------

/** The Event Settings fields an event needs before it can be scheduled, with their labels. */
export const REQUIRED_EVENT_FIELDS: { key: keyof EventSettingsRow; label: string }[] = [
    { key: "name", label: "Name" },
    { key: "themeColor", label: "Event Color" },
    { key: "logoUrl", label: "Logo URL" },
    { key: "cventEventId", label: "Cvent Event ID" },
    { key: "cventAppointmentEventId", label: "Cvent Appointment Event ID" },
];

/** What the Setup card shows. */
export type SetupSummary = {
    /** Labels of the required Event Settings fields that are blank. */
    missingFields: string[];
    /** Whether any Cvent appointment type is mapped to sponsor-to-delegate. */
    sponsorTypeMapped: boolean;
};

/**
 * Checks an event's settings for blank required fields and a sponsor-to-delegate type mapping.
 *
 * @param {EventSettingsRow} event - The event's settings row.
 * @returns {SetupSummary} The missing fields and whether the sponsor type is mapped.
 */
export function summarizeSetup(event: EventSettingsRow): SetupSummary {
    const missingFields = REQUIRED_EVENT_FIELDS.filter(({ key }) => {
        const value = event[key];
        return typeof value !== "string" || value.trim() === "";
    }).map(({ label }) => label);

    const kinds = (event.appointmentTypeKinds ?? null) as AppointmentTypeKinds | null;
    const sponsorTypeMapped = Object.keys(kinds ?? {}).some(
        (typeId) => kindForAppointmentType(kinds, typeId) === "sponsor_delegate",
    );

    return { missingFields, sponsorTypeMapped };
}

/** What the Sponsor Meeting Requests card shows. */
export type RequestSummary = {
    /** How many requests the event has. */
    requests: number;
    /** How many sponsor companies made them. */
    companies: number;
};

/**
 * Counts an event's sponsor meeting requests and the companies that made them.
 * A request's requester is the sponsor company's Account id, so each distinct one is a company.
 *
 * @param {{ requesterId: string }[]} rows - The event's request rows.
 * @returns {RequestSummary} The request and company counts.
 */
export function summarizeRequests(rows: { requesterId: string }[]): RequestSummary {
    return {
        requests: rows.length,
        companies: new Set(rows.map((r) => r.requesterId)).size,
    };
}

/** What the Sponsor Meetings card shows. */
export type MeetingSummary = {
    /** Every meeting the sponsor meeting pages count: this database's meetings plus those only in Cvent. */
    scheduled: number;
    /** Meetings in Cvent and up to date. */
    synced: number;
    /** Meetings changed since they were pushed. */
    modified: number;
    /** Meetings not in Cvent yet. */
    notPushed: number;
    /** Cvent appointments this database has no meeting for. Null when Cvent couldn't be read. */
    onlyInCvent: number | null;
};

/**
 * Counts an event's sponsor meetings by sync status.
 *
 * @param {SyncFields[]} rows - The event's meeting rows from this database.
 * @param {number | null} onlyInCvent - Sponsor appointments only in Cvent, or null when Cvent couldn't be read.
 * @returns {MeetingSummary} The counts.
 */
export function summarizeMeetings(rows: SyncFields[], onlyInCvent: number | null): MeetingSummary {
    const counts = { synced: 0, modified: 0, notPushed: 0 };
    for (const row of rows) {
        const status = getSyncStatus(row);
        if (status === "synced") counts.synced++;
        else if (status === "modified") counts.modified++;
        else counts.notPushed++;
    }
    return {
        scheduled: rows.length + (onlyInCvent ?? 0),
        ...counts,
        onlyInCvent,
    };
}
