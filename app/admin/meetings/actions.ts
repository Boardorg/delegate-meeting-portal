"use server";

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import {
    meetingRequests,
    scheduledMeetings,
    type NewScheduledMeeting,
} from "@/lib/db/schema";
import { loadAttendees } from "@/lib/attendees/loader";
import { loadEventScheduleData } from "@/lib/cvent/mapper";
import { getEventAppointments, cancelAppointment } from "@/lib/cvent/client";
import { pushMeetingRows, needsSync } from "@/lib/cvent/push";
import { preexistingFromAppointments } from "@/lib/cvent/preexisting";
import {
    buildSyncReport,
    isAppointmentAlreadyGone,
    parseCventError,
    type SyncReport,
} from "@/lib/cvent/syncReport";
import {
    runScheduler,
    type PreexistingSchedule,
} from "@/lib/scheduling/engine";
import { sponsorCompaniesByAccountId } from "@/lib/attendees/companies";
import {
    buildSchedulerReport,
    type SchedulerReport,
} from "@/lib/scheduling/report";
import { pairKey } from "@/lib/scheduling/helpers";
import { loadMockRequests } from "@/lib/scheduling/loader";
import { paginate, type Page } from "@/lib/admin/pagination";
import { contractedMeetings } from "@/lib/attendees/caps";
import type { Attendee, MeetingRequest } from "@/types";

// ---------------------------------------------------------------------------
// Server actions for /admin/meetings — the sponsor list page.
//
// Reads pull from both the meetingRequests table (request counts) and the
// scheduledMeetings table (scheduled counts). Sponsor profiles come from
// the attendee loader (Salesforce or mock, depending on USE_MOCK).
//
// Contracted meeting counts are derived from sponsorTier (diamond: 8,
// standard: 5). Bonus meetings are not yet in the attendee data source and
// show as 0 until that field is available from Salesforce.
// ---------------------------------------------------------------------------

/** One company row as returned to the client table (one row per sponsor company). */
export type SponsorRow = {
    /** Company Salesforce Account id — the sponsor-side party id. */
    accountId: string;
    company: string;
    sponsorTier: "diamond" | "standard";
    /** Package meetings guaranteed by tier (shared company budget). Diamond: 8, Standard: 5. */
    contracted: number;
    /** Bonus meetings beyond the package. Not yet in attendee data; always 0. */
    bonus: number;
    requestCount: number;
    scheduledCount: number;
};

/** Columns the sponsor list can be sorted by. */
export type SponsorSortField =
    | "company"
    | "tier"
    | "requestCount"
    | "scheduledCount";

export type SponsorsPage = Page<SponsorRow>;

/**
 * Returns a sorted, searched, paginated page of sponsors for an event,
 * with their request and scheduled meeting counts attached.
 *
 * @param {{ eventCode: string; q?: string; sortField?: SponsorSortField; sortDir?: "asc" | "desc"; page?: number }} params
 * @returns {Promise<SponsorsPage>} The page of sponsor rows plus totals.
 */
export async function listSponsorsPage(params: {
    eventCode: string;
    q?: string;
    sortField?: SponsorSortField;
    sortDir?: "asc" | "desc";
    page?: number;
}): Promise<SponsorsPage> {
    // Get all attendees, meeting requests, and scheduled meetings for this event in parallel.
    const [attendees, requestRows, meetingRows] = await Promise.all([
        loadAttendees(false, params.eventCode),
        db
            .select({ requesterId: meetingRequests.requesterId })
            .from(meetingRequests)
            .where(eq(meetingRequests.eventCode, params.eventCode)),
        db
            .select({
                attendeeA: scheduledMeetings.attendeeA,
                attendeeB: scheduledMeetings.attendeeB,
            })
            .from(scheduledMeetings)
            .where(eq(scheduledMeetings.eventCode, params.eventCode)),
    ]);

    // Build a map of request counts keyed by requester party id (company
    // account id on the sponsor side).
    const requestCountMap = new Map<string, number>();
    for (const r of requestRows) {
        requestCountMap.set(
            r.requesterId,
            (requestCountMap.get(r.requesterId) ?? 0) + 1,
        );
    }

    // Build a map of scheduled meeting counts keyed by party id. attendeeA is the
    // company account id, so a company's meetings all count under one key.
    const scheduledCountMap = new Map<string, number>();
    for (const m of meetingRows) {
        scheduledCountMap.set(
            m.attendeeA,
            (scheduledCountMap.get(m.attendeeA) ?? 0) + 1,
        );
        scheduledCountMap.set(
            m.attendeeB,
            (scheduledCountMap.get(m.attendeeB) ?? 0) + 1,
        );
    }

    // Group sponsor reps into companies — one row per company.
    const companies = sponsorCompaniesByAccountId(attendees);

    // Map companies to SponsorRow, attaching request and scheduled counts.
    let rows: SponsorRow[] = [...companies.values()].map((c) => ({
        accountId: c.accountId,
        company: c.name,
        sponsorTier: c.tier === "diamond" ? "diamond" : "standard",
        contracted: contractedMeetings(c.tier),
        bonus: 0,
        requestCount: requestCountMap.get(c.accountId) ?? 0,
        scheduledCount: scheduledCountMap.get(c.accountId) ?? 0,
    }));

    // Apply search filter if q is provided. Search matches company, case-insensitive.
    const q = (params.q ?? "").trim().toLowerCase();
    if (q) {
        rows = rows.filter((r) => r.company.toLowerCase().includes(q));
    }

    // Apply sorting if sortField is provided.
    const dir = params.sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
        switch (params.sortField) {
            case "tier":
                return dir * a.sponsorTier.localeCompare(b.sponsorTier);
            case "requestCount":
                return dir * (a.requestCount - b.requestCount);
            case "scheduledCount":
                return dir * (a.scheduledCount - b.scheduledCount);
            default:
                return dir * a.company.localeCompare(b.company);
        }
    });

    // Paginate the results.
    const total = rows.length;
    const { page, pageSize, pageCount, offset } = paginate(total, params);

    // Return the paginated slice along with totals and metadata.
    return {
        rows: rows.slice(offset, offset + pageSize),
        total,
        page,
        pageSize,
        pageCount,
    };
}

/**
 * Builds the engine's pre-existing schedule from the event's current Cvent
 * appointments. Wraps preexistingFromAppointments (which maps participant
 * contact ids to party ids) around the Cvent fetch, returning an empty schedule
 * (and logging) when Cvent is unavailable, so a run still proceeds and falls
 * back to the DB-based reconciliation.
 *
 * @param {string} eventCode - The event to read existing Cvent appointments for.
 * @param {Attendee[]} attendees - Loaded attendees, for contact-id → party-id mapping.
 * @returns {Promise<PreexistingSchedule>} Pairs + per-party busy times to schedule around.
 */
async function buildPreexistingFromCvent(
    eventCode: string,
    attendees: Attendee[],
): Promise<PreexistingSchedule> {
    let appointments;
    try {
        appointments = await getEventAppointments(eventCode);
    } catch (err) {
        console.warn(
            `runSchedulerForEvent: could not load existing Cvent appointments for "${eventCode}" — ` +
                `scheduling without them. ${err instanceof Error ? err.message : String(err)}`,
        );
        return {};
    }

    return preexistingFromAppointments(appointments, attendees);
}

/**
 * Runs the scheduling engine for an event and replaces all un-pushed portal meetings
 * with the fresh engine output. Meetings already pushed to Cvent are preserved via
 * post-reconciliation: the engine runs freely, then any fresh meeting that duplicates
 * or conflicts with a pushed meeting is dropped before insert.
 *
 * The engine and the DB both key meetings by PARTY id (a company Account id on
 * the sponsor side, a delegate salesforceId on the other), so no id translation
 * is needed here in either mock or production mode.
 *
 * @param {string} eventCode - The event to schedule meetings for.
 * @returns {Promise<SchedulerReport>} A DB-friendly summary of the run: counts,
 *   per-interest-level breakdown, and unscheduled requests with reasons.
 */
export async function runSchedulerForEvent(
    eventCode: string,
): Promise<SchedulerReport> {
    const isMock = process.env.USE_MOCK === "true";
    const mockRequestsPath = `${process.cwd()}/data/mock/requests.json`;

    // Load attendees, requests, the event's Cvent availability, and already-pushed meetings.
    const [attendees, requestRows, scheduleData, pushedRows] =
        await Promise.all([
            loadAttendees(false, eventCode),
            isMock
                ? loadMockRequests(mockRequestsPath)
                : db
                      .select()
                      .from(meetingRequests)
                      .where(eq(meetingRequests.eventCode, eventCode)),
            loadEventScheduleData(eventCode),
            db
                .select()
                .from(scheduledMeetings)
                .where(
                    and(
                        eq(scheduledMeetings.eventCode, eventCode),
                        isNotNull(scheduledMeetings.cventAppointmentId),
                    ),
                ),
        ]);

    const engineRequests: MeetingRequest[] = requestRows.map((r) => ({
        id: String(r.id),
        requesterId: r.requesterId,
        targetId: r.targetId,
        rank: r.rank,
    }));

    // Fetch meetings that already exist in Cvent for this event, so the engine
    // schedules around them (no duplicate pairings, no double-booking an
    // attendee against a Cvent time). Degrade gracefully if Cvent is
    // unavailable — the DB-based reconciliation below still guards pushed rows.
    const preexisting = await buildPreexistingFromCvent(eventCode, attendees);

    // Run the engine. It avoids the pre-existing Cvent pairs/times; pushed DB
    // meetings are additionally guarded via post-reconciliation below.
    const { schedule, skipReasons } = await runScheduler(
        attendees,
        engineRequests,
        scheduleData.timeslots,
        scheduleData.locations,
        preexisting,
    );

    // Build reconciliation sets from pushed meetings. Party ids (company account
    // ids / delegate salesforceIds) are used throughout — the same keys the
    // engine emits — so no conversion is needed here.
    const pushedPairs = new Set<string>();
    const blockedSlots = new Set<string>(); // "${attendeeId}:${timeslotId}"
    for (const row of pushedRows) {
        pushedPairs.add(pairKey(row.attendeeA, row.attendeeB));
        blockedSlots.add(`${row.attendeeA}:${row.timeslotId}`);
        blockedSlots.add(`${row.attendeeB}:${row.timeslotId}`);
    }

    // Drop any fresh meeting that duplicates a pushed pair or reuses a timeslot already
    // held by a pushed meeting for either attendee. Everything else is safe to insert.
    // The engine's own ids are timestamp-suffixed (see lib/scheduling/engine.ts), so
    // they stay unique across runs and are safe to push to Cvent as-is.
    //
    // Dropped pairs are also collected here as reconciledOutPairs: the report
    // attributes these to "conflict_existing" rather than an engine skip reason.
    const reconciledSchedule: typeof schedule = [];
    const reconciledOutPairs = new Set<string>();
    for (const m of schedule) {
        const pair = pairKey(m.attendeeA, m.attendeeB);
        const dropped =
            pushedPairs.has(pair) ||
            blockedSlots.has(`${m.attendeeA}:${m.timeslotId}`) ||
            blockedSlots.has(`${m.attendeeB}:${m.timeslotId}`);
        if (dropped) {
            reconciledOutPairs.add(pair);
        } else {
            reconciledSchedule.push(m);
        }
    }

    // Replace all un-pushed portal meetings for this event with the reconciled output.
    await db
        .delete(scheduledMeetings)
        .where(
            and(
                eq(scheduledMeetings.eventCode, eventCode),
                eq(scheduledMeetings.source, "portal"),
                isNull(scheduledMeetings.cventAppointmentId),
            ),
        );

    if (reconciledSchedule.length > 0) {
        const toInsert: NewScheduledMeeting[] = reconciledSchedule.map((m) => ({
            id: m.id,
            eventCode,
            attendeeA: m.attendeeA,
            attendeeB: m.attendeeB,
            day: m.day,
            timeslotId: m.timeslotId,
            passNumber: m.passNumber,
            mutual: m.mutual,
            matchKind: m.matchKind,
            rank: m.rank,
            source: m.source,
            locationId: m.locationId,
            cventAppointmentId: null,
            lastModifiedAt: null,
            lastPushedAt: null,
        }));
        await db.insert(scheduledMeetings).values(toInsert);
    }

    // Revalidate the admin meetings page to reflect the new schedule.
    revalidatePath("/admin/meetings");

    return buildSchedulerReport({
        eventCode,
        generatedAt: new Date().toISOString(),
        attendees,
        requests: engineRequests,
        reconciled: reconciledSchedule,
        skipReasons,
        reconciledOutPairs,
        preexistingPairs: preexisting.pairs ?? new Set(),
    });
}

/**
 * Pushes all un-synced portal meetings for an entire event to Cvent. Covers
 * both not-yet-pushed meetings (a fresh createAppointment) and meetings edited
 * since their last push (a replacement createAppointment, then the old
 * appointment is cancelled). Each meeting's time is resolved from its Cvent
 * timeslot, and participants are mapped from Salesforce ids to Cvent contact
 * ids. Per-meeting failures are logged and skipped so one bad row doesn't
 * abort the whole push.
 *
 * @param {string} eventCode - The event to push meetings for.
 * @returns {Promise<SyncReport>} A DB-friendly summary of the run: how many
 *   meetings were already synced, attempted, created/updated, and — for
 *   failures — an actionable reason per meeting.
 */
export async function pushAllForEvent(eventCode: string): Promise<SyncReport> {
    // Load every portal meeting for this event, so the report can distinguish
    // meetings that still need pushing from ones already synced and up to date.
    const portalRows = await db
        .select()
        .from(scheduledMeetings)
        .where(
            and(
                eq(scheduledMeetings.eventCode, eventCode),
                eq(scheduledMeetings.source, "portal"),
            ),
        );

    // A row needs pushing if it was never synced, or was modified since its
    // last push. Everything else is already synced and up to date. Applied in
    // memory (rather than in the query) so the untouched rows are still counted
    // for the report.
    const toPush = portalRows.filter(needsSync);
    const alreadySynced = portalRows.length - toPush.length;

    const summary = await pushMeetingRows(eventCode, toPush);

    // Revalidate the admin meetings page to reflect the updated push status.
    revalidatePath("/admin/meetings");

    return buildSyncReport({
        eventCode,
        generatedAt: new Date().toISOString(),
        totalPortalMeetings: portalRows.length,
        alreadySynced,
        results: summary.results,
    });
}

// ---------------------------------------------------------------------------
// Bulk maintenance actions — for resetting an event's schedule from the
// Manage Meetings toolbar. Both return an ephemeral MaintenanceReport the UI
// renders in MaintenanceReportPanel (mirroring the scheduler/sync reports).
// ---------------------------------------------------------------------------

/**
 * Result of a bulk maintenance action, shown in MaintenanceReportPanel. A
 * discriminated union so one panel can render both operations.
 */
export type MaintenanceReport =
    | {
          kind: "clear_unsynced";
          eventCode: string;
          generatedAt: string;
          /** Number of un-synced portal meetings deleted from the DB. */
          deleted: number;
      }
    | {
          kind: "unpush_synced";
          eventCode: string;
          generatedAt: string;
          /** Synced portal meetings found (Cvent cancels attempted). */
          total: number;
          /** How many were cancelled in Cvent and unlinked in the DB. */
          unpushed: number;
          /**
           * How many were already gone in Cvent (cancelled manually or
           * missing). Unlinked in the DB anyway, since there's nothing to cancel.
           */
          alreadyGone: number;
          /** How many failed to cancel (left synced in the DB). */
          failed: number;
          /** Per-meeting failure detail. */
          failures: { meetingId: string; label: string; detail: string }[];
          /** Per-meeting notes for the already-gone meetings. */
          notes: { meetingId: string; label: string; detail: string }[];
      };

/**
 * Deletes every un-synced portal meeting for an event from the DB — rows that
 * were never pushed to Cvent (no appointment id). Meetings already synced to
 * Cvent are left untouched so their Cvent appointments aren't orphaned; this is
 * the same guard the scheduler uses before re-inserting fresh output.
 *
 * @param {string} eventCode - The event whose un-synced meetings to clear.
 * @returns {Promise<MaintenanceReport>} How many meetings were deleted.
 */
export async function clearUnsyncedForEvent(
    eventCode: string,
): Promise<MaintenanceReport> {
    // Only un-synced (cventAppointmentId IS NULL) portal rows. Cvent-native
    // rows (source "cvent") are read-only and excluded. RETURNING gives us the
    // deleted count for the report.
    const deleted = await db
        .delete(scheduledMeetings)
        .where(
            and(
                eq(scheduledMeetings.eventCode, eventCode),
                eq(scheduledMeetings.source, "portal"),
                isNull(scheduledMeetings.cventAppointmentId),
            ),
        )
        .returning({ id: scheduledMeetings.id });

    // Revalidate the admin meetings page to reflect the cleared schedule.
    revalidatePath("/admin/meetings");

    return {
        kind: "clear_unsynced",
        eventCode,
        generatedAt: new Date().toISOString(),
        deleted: deleted.length,
    };
}

/**
 * Cancels the Cvent appointment behind every synced portal meeting for an
 * event, then clears that meeting's sync link (cventAppointmentId + lastPushedAt)
 * so it reads as un-synced again. The DB row itself is kept — this only unwinds
 * the push to Cvent, not the schedule.
 *
 * The DB link is cleared only after the Cvent cancel succeeds, so a failed
 * cancel leaves the row pointing at a still-live appointment rather than
 * silently orphaning it. Per-meeting failures are collected and skipped so one
 * bad cancel doesn't abort the batch.
 *
 * Note: Cvent never frees a cancelled appointment's `code`, so re-pushing these
 * exact rows would collide (APPT_CODE_ALREADY_EXISTS). The normal reset flow
 * regenerates ids first — unpush, then clear/re-run the engine — so codes stay
 * fresh; see lib/cvent/push.ts.
 *
 * @param {string} eventCode - The event whose synced meetings to unpush.
 * @returns {Promise<MaintenanceReport>} Counts plus per-meeting failure detail.
 */
export async function unpushAllForEvent(
    eventCode: string,
): Promise<MaintenanceReport> {
    // Synced portal meetings: rows we pushed (they carry a Cvent appointment
    // id). Cvent-native rows are read-only and excluded.
    const syncedRows = await db
        .select()
        .from(scheduledMeetings)
        .where(
            and(
                eq(scheduledMeetings.eventCode, eventCode),
                eq(scheduledMeetings.source, "portal"),
                isNotNull(scheduledMeetings.cventAppointmentId),
            ),
        );

    // Names for the failure labels. attendeeA is a company party id (resolve via
    // the company map); attendeeB is a delegate (resolve by salesforceId).
    const attendees = await loadAttendees(false, eventCode);
    const attendeeById = new Map(attendees.map((a) => [a.salesforceId, a]));
    const companiesByAccountId = sponsorCompaniesByAccountId(attendees);

    const failures: { meetingId: string; label: string; detail: string }[] = [];
    const notes: { meetingId: string; label: string; detail: string }[] = [];
    let unpushed = 0;
    let alreadyGone = 0;

    for (const row of syncedRows) {
        // Guarded by the query above, but keep the type narrow for the DB call.
        if (!row.cventAppointmentId) continue;
        const label = `${companiesByAccountId.get(row.attendeeA)?.name ?? row.attendeeA} & ${
            attendeeById.get(row.attendeeB)?.name ?? row.attendeeB
        }`;

        // Unlinks the meeting in the DB so it reads as un-synced (row kept).
        const unlink = () =>
            db
                .update(scheduledMeetings)
                .set({ cventAppointmentId: null, lastPushedAt: null })
                .where(eq(scheduledMeetings.id, row.id));

        try {
            // Cancel in Cvent first, then unlink. Only clear once the cancel
            // succeeds, so a real failure leaves the row pointing at a live
            // appointment rather than silently orphaning it.
            await cancelAppointment(eventCode, row.cventAppointmentId);
            await unlink();
            unpushed++;
        } catch (err) {
            // If the appointment is already gone in Cvent (cancelled manually or
            // missing), there's nothing left to cancel — unlink locally anyway
            // and note it rather than treating it as a failure.
            if (isAppointmentAlreadyGone(err)) {
                await unlink();
                alreadyGone++;
                notes.push({
                    meetingId: row.id,
                    label,
                    detail: "Already cancelled or missing in Cvent — unsynced locally.",
                });
                continue;
            }

            // A genuine failure: leave the row synced. Prefer Cvent's
            // human-readable message when present.
            const base = err instanceof Error ? err.message : String(err);
            const cventMessage = parseCventError(
                (err as { body?: string }).body,
            ).message;
            failures.push({
                meetingId: row.id,
                label,
                detail: cventMessage ?? base,
            });
        }
    }

    // Revalidate the admin meetings page to reflect the updated sync status.
    revalidatePath("/admin/meetings");

    return {
        kind: "unpush_synced",
        eventCode,
        generatedAt: new Date().toISOString(),
        total: syncedRows.length,
        unpushed,
        alreadyGone,
        failed: failures.length,
        failures,
        notes,
    };
}
