import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { meetingRequests, scheduledMeetings, type EventSettingsRow } from "@/lib/db/schema";
import { loadAttendees } from "@/lib/attendees/loader";
import { getEventAppointments } from "@/lib/cvent/client";
import { countAppointmentsNotInPortal } from "@/lib/cvent/cventOnly";
import { countBoothProblemsForEvent } from "@/app/admin/meetings/actions";
import {
    summarizeSetup,
    summarizeRequests,
    summarizeMeetings,
    type SetupSummary,
    type RequestSummary,
    type MeetingSummary,
} from "@/lib/admin/overview";

// ---------------------------------------------------------------------------
// Loads the admin Overview for one event.
// It reads the same data as the pages it links to, so its counts match them.
// ---------------------------------------------------------------------------

/** Everything the Overview page shows for one event. */
export type EventOverview = {
    setup: SetupSummary;
    /** Sponsor companies with a booth or package problem. Null when the booths couldn't be checked. */
    boothProblems: number | null;
    requests: RequestSummary;
    meetings: MeetingSummary;
};

/**
 * Counts the sponsor appointments in Cvent that this database has no meeting for.
 * Matches what the Sponsor Meetings page adds to each company's Scheduled count.
 * Returns null when Cvent can't be read.
 *
 * @param {string} eventCode - The event.
 * @param {Set<string>} knownAppointmentIds - Cvent appointment ids stored on this database's meetings.
 * @returns {Promise<number | null>} The count, or null.
 */
async function countOnlyInCvent(
    eventCode: string,
    knownAppointmentIds: Set<string>,
): Promise<number | null> {
    try {
        const [attendees, appointments] = await Promise.all([
            loadAttendees(false, eventCode),
            getEventAppointments(eventCode),
        ]);
        let total = 0;
        for (const count of countAppointmentsNotInPortal(appointments, attendees, knownAppointmentIds).values()) {
            total += count;
        }
        return total;
    } catch (err) {
        console.warn(
            `loadEventOverview: could not load Cvent appointments for "${eventCode}". ` +
                `${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
    }
}

/**
 * Checks the sponsor booths, returning null when they can't be checked.
 *
 * @param {string} eventCode - The event.
 * @returns {Promise<number | null>} Companies with a booth or package problem, or null.
 */
async function boothProblemsOrNull(eventCode: string): Promise<number | null> {
    try {
        return await countBoothProblemsForEvent(eventCode);
    } catch (err) {
        console.warn(
            `loadEventOverview: could not check booths for "${eventCode}". ` +
                `${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
    }
}

/**
 * Loads the Overview counts and warnings for one event.
 * Cards that need Cvent come back null when it can't be reached, and the rest still load.
 *
 * @param {EventSettingsRow} event - The selected event's settings.
 * @returns {Promise<EventOverview>} The Overview data.
 */
export async function loadEventOverview(event: EventSettingsRow): Promise<EventOverview> {
    const [requestRows, meetingRows, boothProblems] = await Promise.all([
        db
            .select({ requesterId: meetingRequests.requesterId })
            .from(meetingRequests)
            .where(eq(meetingRequests.eventCode, event.code)),
        db
            .select({
                cventAppointmentId: scheduledMeetings.cventAppointmentId,
                lastModifiedAt: scheduledMeetings.lastModifiedAt,
                lastPushedAt: scheduledMeetings.lastPushedAt,
            })
            .from(scheduledMeetings)
            .where(eq(scheduledMeetings.eventCode, event.code)),
        boothProblemsOrNull(event.code),
    ]);

    const knownAppointmentIds = new Set(
        meetingRows.map((m) => m.cventAppointmentId).filter((id): id is string => !!id),
    );
    const onlyInCvent = await countOnlyInCvent(event.code, knownAppointmentIds);

    return {
        setup: summarizeSetup(event),
        boothProblems,
        requests: summarizeRequests(requestRows),
        meetings: summarizeMeetings(meetingRows, onlyInCvent),
    };
}
