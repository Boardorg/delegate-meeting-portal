import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
    roundtableSeats,
    roundtables,
    scheduledMeetings,
    type RoundtableRow,
    type RoundtableSeatRow,
    type ScheduledMeetingRow,
} from "@/lib/db/schema";
import { loadAttendees } from "@/lib/attendees/loader";
import { loadEventScheduleData, type EventScheduleData } from "@/lib/cvent/mapper";
import { getEventAppointments, type CventExistingAppointment } from "@/lib/cvent/client";
import { getEventSettings } from "@/lib/events/settings";
import type { Attendee } from "@/types";
import { resolveMatchingSettings, type MatchingSettings } from "./settings";
import {
    cventOnlyForDelegates,
    delegateMeetingCounts,
    type CventOnlyForDelegates,
    type DelegateCounts,
} from "./delegateMeetings";

// ---------------------------------------------------------------------------
// Loads what the delegate matching pages and runs need for one event.
// The D2D and roundtable actions share it, so their counts agree.
// ---------------------------------------------------------------------------

/** One event's delegate matching data. */
export type MatchingContext = {
    attendees: Attendee[];
    scheduleData: EventScheduleData;
    settings: MatchingSettings;
    /** Every scheduled_meetings row for the event. */
    rows: ScheduledMeetingRow[];
    /** Every roundtable for the event. */
    roundtableRows: RoundtableRow[];
    /** Every roundtable seat and alternate for the event. */
    seatRows: RoundtableSeatRow[];
    /** The event's active Cvent appointments. Null when Cvent couldn't be read. */
    appointments: CventExistingAppointment[] | null;
    /** Cvent appointments this database has no meeting or roundtable for, with their delegates. */
    cventOnly: CventOnlyForDelegates[];
    /** Each delegate's S2D and D2D meetings, in the portal and in Cvent. */
    counts: Map<string, DelegateCounts>;
};

/**
 * Reads an event's matching settings, falling back to the defaults when the row can't be read.
 *
 * @param {string} eventCode - The event.
 * @returns {Promise<MatchingSettings>} The settings to use.
 */
export async function loadMatchingSettings(eventCode: string): Promise<MatchingSettings> {
    try {
        const row = await getEventSettings(eventCode);
        return resolveMatchingSettings(row?.matchingSettings ?? null);
    } catch (err) {
        console.warn(
            `loadMatchingSettings: could not read matching settings for "${eventCode}". Using the defaults. ` +
                `${err instanceof Error ? err.message : String(err)}`,
        );
        return resolveMatchingSettings(null);
    }
}

/**
 * Loads one event's attendees, schedule, settings, meetings, roundtables and Cvent appointments.
 * The page still loads without Cvent's appointments when Cvent can't be read.
 *
 * @param {string} eventCode - The event.
 * @returns {Promise<MatchingContext>} The data.
 */
export async function loadMatchingContext(eventCode: string): Promise<MatchingContext> {
    const [attendees, scheduleData, settings, rows, roundtableRows, seatRows, appointments] = await Promise.all([
        loadAttendees(false, eventCode),
        loadEventScheduleData(eventCode),
        loadMatchingSettings(eventCode),
        db.select().from(scheduledMeetings).where(eq(scheduledMeetings.eventCode, eventCode)),
        db.select().from(roundtables).where(eq(roundtables.eventCode, eventCode)),
        db.select().from(roundtableSeats).where(eq(roundtableSeats.eventCode, eventCode)),
        getEventAppointments(eventCode).catch((err) => {
            console.warn(
                `loadMatchingContext: could not load Cvent appointments for "${eventCode}". ` +
                    `${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
        }),
    ]);

    // Appointments the portal pushed, meetings and roundtables alike, aren't "only in Cvent".
    const knownAppointmentIds = new Set(
        [...rows, ...roundtableRows]
            .map((r) => r.cventAppointmentId)
            .filter((id): id is string => !!id),
    );
    const cventOnly = cventOnlyForDelegates(appointments ?? [], attendees, knownAppointmentIds);
    return {
        attendees,
        scheduleData,
        settings,
        rows,
        roundtableRows,
        seatRows,
        appointments,
        cventOnly,
        counts: delegateMeetingCounts(rows, cventOnly),
    };
}
