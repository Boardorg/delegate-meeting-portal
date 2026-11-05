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
import {
    NO_ATTENDEES_MESSAGE,
    hasSponsorsAndDelegates,
    reconcileWithPushed,
} from "@/lib/scheduling/helpers";
import { loadMockRequests } from "@/lib/scheduling/loader";
import { paginate, type Page } from "@/lib/admin/pagination";
import {
    companyMaximumMeetings,
    companyMeetingsAtOnce,
} from "@/lib/attendees/caps";
import { loadCompanyBooths } from "@/lib/scheduling/boothData";
import { countBoothProblems } from "@/lib/scheduling/booths";
import { checkAppointmentTypeMapping } from "@/lib/events/meetingKinds";
import type { Attendee, MeetingRequest } from "@/types";

// ---------------------------------------------------------------------------
// Server actions for /admin/meetings — the sponsor list page.
//
// Reads pull from both the meetingRequests table (request counts) and the
// scheduledMeetings table (scheduled counts). Sponsor profiles come from
// the attendee loader (Salesforce or mock, depending on USE_MOCK).
//
// Purchased and bonus meetings come from the sponsor Opportunity in
// Salesforce. Each company's target is its maximum, worked out by
// companyMaximumMeetings() in lib/attendees/caps.ts, the same rule the
// scheduler uses.
// ---------------------------------------------------------------------------

/** One company row as returned to the client table (one row per sponsor company). */
export type SponsorRow = {
    /** Company Salesforce Account id — the sponsor-side party id. */
    accountId: string;
    company: string;
    sponsorTier: "diamond" | "standard";
    /** Meetings__c on the sponsor Opportunity. Null when blank. */
    purchased: number | null;
    /** Cvent_Bonus_Meetings__c on the sponsor Opportunity. Null when blank. */
    bonus: number | null;
    /** The company's meeting maximum, its target (shared company budget). */
    maximum: number;
    /** True when the maximum is the tier count, because all three count fields are blank. */
    maximumFromTier: boolean;
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
    let rows: SponsorRow[] = [...companies.values()].map((c) => {
        const max = companyMaximumMeetings(c);
        return {
            accountId: c.accountId,
            company: c.name,
            sponsorTier: c.tier === "diamond" ? "diamond" : "standard",
            purchased: c.purchasedMeetings,
            bonus: c.bonusMeetings,
            maximum: max.maximum,
            maximumFromTier: max.source === "tier",
            requestCount: requestCountMap.get(c.accountId) ?? 0,
            scheduledCount: scheduledCountMap.get(c.accountId) ?? 0,
        };
    });

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
 * Counts the sponsor companies whose booth or package stops their meetings.
 * "Run Scheduling Engine" warns before running when this is above 0.
 * Returns null when the booths couldn't be checked.
 *
 * @param {string} eventCode - The event to check.
 * @returns {Promise<number | null>} How many companies have a booth problem, or null.
 */
export async function countBoothProblemsForEvent(
    eventCode: string,
): Promise<number | null> {
    const [attendees, scheduleData] = await Promise.all([
        loadAttendees(false, eventCode),
        loadEventScheduleData(eventCode),
    ]);
    const booths = await loadCompanyBooths(
        eventCode,
        attendees,
        scheduleData.locations,
    );
    return booths.ok ? countBoothProblems(booths.booths) : null;
}

/**
 * Counts each party's meetings, from both sides of each meeting.
 *
 * @param {{ attendeeA: string; attendeeB: string }[]} rows - The meetings.
 * @returns {Map<string, number>} The count per party id.
 */
function countMeetingsByParty(
    rows: { attendeeA: string; attendeeB: string }[],
): Map<string, number> {
    const counts = new Map<string, number>();
    for (const r of rows) {
        counts.set(r.attendeeA, (counts.get(r.attendeeA) ?? 0) + 1);
        counts.set(r.attendeeB, (counts.get(r.attendeeB) ?? 0) + 1);
    }
    return counts;
}

/**
 * Merges two counts per party, keeping the larger one for each.
 *
 * @param {Map<string, number> | undefined} a - One count, such as Cvent's.
 * @param {Map<string, number>} b - The other count, such as the pushed DB rows.
 * @returns {Map<string, number>} The larger count per party.
 */
function largerCounts(
    a: Map<string, number> | undefined,
    b: Map<string, number>,
): Map<string, number> {
    const out = new Map(a ?? []);
    for (const [party, n] of b) out.set(party, Math.max(out.get(party) ?? 0, n));
    return out;
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
 * Result of a scheduler run.
 * A run that stops before changing anything returns a message instead of a report.
 * It is a return value rather than a thrown error, so the message reaches the admin in production builds too.
 */
export type RunSchedulerResult =
    | { ok: true; report: SchedulerReport }
    | { ok: false; error: string };

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
 * The run stops before changing anything when no appointment type is mapped to `sponsor_delegate`.
 * Otherwise it would delete every un-pushed meeting and create none.
 * It also stops when the attendees it would use have no sponsors or no delegates, for the same reason.
 * It also stops when the event's booth mapping can't be read, since meetings could land in the wrong booth.
 * Types with no mapping are listed in the report as a warning.
 *
 * Each sponsor company only gets meetings at its booth.
 * Companies with a booth or package problem get none, and the report lists them.
 *
 * @param {string} eventCode - The event to schedule meetings for.
 * @returns {Promise<RunSchedulerResult>} A DB-friendly summary of the run: counts,
 *   per-interest-level breakdown, and unscheduled requests with reasons.
 *   Or a message saying why the run stopped.
 */
export async function runSchedulerForEvent(
    eventCode: string,
): Promise<RunSchedulerResult> {
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

    // Attendees who cancelled in Cvent are left out, so no new meetings are made with them.
    // Un-pushed meetings are rebuilt from scratch below, so cancelled attendees drop out of those.
    // Meetings already pushed to Cvent are kept for an admin to reassign.
    // The report below still gets everyone, so it can say why those requests went unscheduled.
    const schedulable = attendees.filter((a) => !a.cventCancelled);

    // Stop before changing anything when the scheduler would have no sponsors or no delegates.
    // loadAttendees returns no one when Cvent's attendee lookup fails, while timeslots load separately.
    if (!hasSponsorsAndDelegates(schedulable)) {
        return { ok: false, error: NO_ATTENDEES_MESSAGE };
    }

    // Stop before changing anything when sponsor meetings have no slots to use.
    // The engine only books sponsor meetings into sponsor_delegate slots.
    // This also covers a stale mapping and an empty slot list from Cvent.
    const mapping = checkAppointmentTypeMapping(
        scheduleData.appointmentTypes,
        scheduleData.appointmentTypeKinds,
        scheduleData.timeslots,
    );
    if (!mapping.ok) return { ok: false, error: mapping.message };

    // Each sponsor company's booth, built from every attendee so a booth claim
    // doesn't depend on who is still registered. Stop before changing anything
    // when the manual booth mapping can't be read.
    const booths = await loadCompanyBooths(
        eventCode,
        attendees,
        scheduleData.locations,
    );
    if (!booths.ok) return { ok: false, error: booths.error };

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

    // Existing meetings count toward each company's maximum before the run books anything.
    // Cvent's appointment list already includes pushed meetings, so the two counts overlap.
    // The larger one is used per party, which still counts pushed meetings when Cvent
    // couldn't be read, or in mock mode where Cvent lists none.
    preexisting.meetingCountByParty = largerCounts(
        preexisting.meetingCountByParty,
        countMeetingsByParty(pushedRows),
    );

    // When Cvent's appointment list couldn't be read, a slot's room can't be matched by location name.
    // The pushed meetings in each timeslot are taken off its room instead.
    if (!preexisting.bookedBySlot) {
        const byTimeslot = new Map<string, number>();
        for (const r of pushedRows) {
            byTimeslot.set(r.timeslotId, (byTimeslot.get(r.timeslotId) ?? 0) + 1);
        }
        preexisting.bookedByTimeslotId = byTimeslot;
    }

    // Run the engine. It avoids the pre-existing Cvent pairs/times; pushed DB
    // meetings are additionally guarded via post-reconciliation below.
    //
    // `effectiveRequests` is what the engine actually considered: the portal
    // requests above plus one delegate→sponsor request per entry in each
    // delegate's intake-form "sponsors I want to meet" answer. The report is
    // built from it so its tallies match the run.
    //
    // The engine only gets `schedulable`, the attendees who haven't cancelled (see above).
    const { schedule, skipReasons, effectiveRequests } = await runScheduler(
        schedulable,
        engineRequests,
        scheduleData.timeslots,
        scheduleData.locations,
        preexisting,
        booths.booths,
    );

    // Reconcile against pushed meetings. Party ids (company account
    // ids / delegate salesforceIds) are used throughout — the same keys the
    // engine emits — so no conversion is needed here.
    //
    // Drop any fresh meeting that duplicates a pushed pair, or that would give either
    // party more meetings at that time than it may hold. A delegate holds 1 at a time,
    // and a sponsor company up to its meetings-at-once limit.
    // Everything else is safe to insert.
    // The engine's own ids are timestamp-suffixed (see lib/scheduling/engine.ts), so
    // they stay unique across runs. A never-pushed id is safe to send to Cvent as its code
    // (see appointmentCode() in lib/cvent/push.ts).
    //
    // Dropped pairs are also collected here as reconciledOutPairs: the report
    // attributes these to "conflict_existing" rather than an engine skip reason.
    const schedulableCompanies = sponsorCompaniesByAccountId(schedulable);
    /**
     * How many meetings a party may hold at one start time.
     * A sponsor company may hold up to its meetings-at-once limit, and anyone else 1.
     *
     * @param {string} party - The party id.
     * @returns {number} The at-once limit.
     */
    const atOnceOf = (party: string): number => {
        const company = schedulableCompanies.get(party);
        return company ? companyMeetingsAtOnce(company) : 1;
    };
    const { kept: reconciledSchedule, droppedPairs: reconciledOutPairs } =
        reconcileWithPushed(
            schedule,
            pushedRows,
            scheduleData.timeslotById,
            atOnceOf,
        );

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

    return {
        ok: true,
        report: buildSchedulerReport({
            eventCode,
            generatedAt: new Date().toISOString(),
            attendees,
            requests: effectiveRequests,
            reconciled: reconciledSchedule,
            skipReasons,
            reconciledOutPairs,
            preexistingPairs: preexisting.pairs ?? new Set(),
            unmappedAppointmentTypes: mapping.unmappedTypeNames,
            companyBooths: booths.booths,
        }),
    };
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

    // Every portal meeting goes in as well, so the host split for same-time meetings
    // counts the ones already synced (see lib/cvent/hostSplit.ts).
    const summary = await pushMeetingRows(eventCode, toPush, portalRows);

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
 * event, then clears that meeting's cventAppointmentId so it reads as
 * un-synced again. The DB row itself is kept — this only unwinds the push to
 * Cvent, not the schedule.
 *
 * The DB link is cleared only after the Cvent cancel succeeds, so a failed
 * cancel leaves the row pointing at a still-live appointment rather than
 * silently orphaning it. Per-meeting failures are collected and skipped so one
 * bad cancel doesn't abort the batch.
 *
 * lastPushedAt is deliberately kept.
 * Cvent never frees a cancelled appointment's `code`, and appointmentCode() in lib/cvent/push.ts builds the next code from lastPushedAt.
 * Keeping it lets these same rows be pushed again without re-running the scheduler.
 * Clearing it would make the next push reuse an old code and fail with APPT_CODE_ALREADY_EXISTS.
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
        // lastPushedAt stays so the next push gets a fresh code.
        const unlink = () =>
            db
                .update(scheduledMeetings)
                .set({ cventAppointmentId: null })
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
