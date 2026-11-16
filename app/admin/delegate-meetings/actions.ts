"use server";

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { scheduledMeetings, type NewScheduledMeeting } from "@/lib/db/schema";
import { needsSync, pushDelegateMeetingRows } from "@/lib/cvent/push";
import { unpushMeetingRows } from "@/lib/cvent/unpush";
import { buildSyncReport, type SyncReport } from "@/lib/cvent/syncReport";
import { getSyncStatus } from "@/lib/cvent/syncStatus";
import { paginate, type Page } from "@/lib/admin/pagination";
import { loadMatchingContext, type MatchingContext } from "@/lib/matching/data";
import {
    NO_D2D_SLOTS_MESSAGE,
    NO_DELEGATES_MESSAGE,
    d2dExclusion,
    d2dOrderWarning,
    runD2DMatching,
    totalMeetingCap,
    type D2DExclusion,
} from "@/lib/matching/d2d";
import {
    busyStartTimes,
    mergeBusyTimes,
    seatedBusyTimes,
    seatedDelegateIds,
    keptD2DMeetings,
    slotRoomLeft,
} from "@/lib/matching/delegateMeetings";
import { buildD2DReport, type D2DReport } from "@/lib/matching/d2dReport";
import type { MaintenanceReport } from "@/app/admin/meetings/actions";
import type { Attendee } from "@/types";

// ---------------------------------------------------------------------------
// Server actions for /admin/delegate-meetings, the D2D list page.
//
// They mirror the sponsor meeting actions in app/admin/meetings/actions.ts, but only touch D2D meetings.
// D2D meetings live in scheduled_meetings with kind "delegate_delegate".
// ---------------------------------------------------------------------------

/** How many of a delegate's D2D meetings are in each sync state. */
export type SyncCounts = { synced: number; modified: number; notPushed: number };

/** One delegate row in the Delegate Meetings list. */
export type DelegateRow = {
    delegateId: string;
    name: string;
    company: string;
    /** S2D meetings, in the portal and only in Cvent. */
    s2dCount: number;
    /** D2D meetings, in the portal and only in Cvent. */
    d2dCount: number;
    /** The most D2D meetings they may have, their total cap minus their S2D meetings. */
    d2dCap: number;
    /** Their portal D2D meetings by sync state. */
    sync: SyncCounts;
    /** Why they can't be matched, when they have meetings anyway. Null for eligible delegates. */
    exclusion: D2DExclusion | null;
};

/** Columns the delegate list can be sorted by. */
export type DelegateSortField = "name" | "company" | "s2dCount" | "d2dCount";

export type DelegatesPage = Page<DelegateRow>;

/**
 * Builds a delegate row from the event's matching data.
 *
 * @param {MatchingContext} ctx - The event's matching data.
 * @param {string} delegateId - The delegate's Salesforce id.
 * @returns {DelegateRow | null} The row, or null when they aren't a known delegate.
 */
function delegateRow(ctx: MatchingContext, delegateId: string): DelegateRow | null {
    const a = ctx.attendees.find((x) => x.salesforceId === delegateId && x.role === "delegate");
    if (!a) return null;
    const counts = ctx.counts.get(delegateId) ?? { s2d: 0, d2d: 0 };
    const sync: SyncCounts = { synced: 0, modified: 0, notPushed: 0 };
    for (const r of ctx.rows) {
        if (r.kind !== "delegate_delegate") continue;
        if (r.attendeeA !== delegateId && r.attendeeB !== delegateId) continue;
        const s = getSyncStatus(r);
        if (s === "synced") sync.synced++;
        else if (s === "modified") sync.modified++;
        else sync.notPushed++;
    }
    return {
        delegateId,
        name: a.name,
        company: a.company,
        s2dCount: counts.s2d,
        d2dCount: counts.d2d,
        d2dCap: Math.max(0, totalMeetingCap(counts.s2d, ctx.settings.d2d) - counts.s2d),
        sync,
        exclusion: matchExclusion(ctx, a),
    };
}

/**
 * Why a delegate can't be matched for D2D, counting a roundtable seat too.
 *
 * @param {MatchingContext} ctx - The event's matching data.
 * @param {Attendee} a - The delegate.
 * @returns {D2DExclusion | null} The reason, or null when they can be matched.
 */
function matchExclusion(ctx: MatchingContext, a: Attendee): D2DExclusion | null {
    return d2dExclusion(a) ?? (seatedDelegateIds(ctx.seatRows).has(a.salesforceId) ? "seated_at_roundtable" : null);
}

/**
 * Returns a sorted, searched, paginated page of delegates for an event.
 * The list has every delegate who can be matched for D2D, plus anyone else who already has a D2D meeting.
 *
 * @param {{ eventCode: string; q?: string; sortField?: DelegateSortField; sortDir?: "asc" | "desc"; page?: number }} params
 * @returns {Promise<DelegatesPage>} The page of rows plus totals.
 */
export async function listDelegatesPage(params: {
    eventCode: string;
    q?: string;
    sortField?: DelegateSortField;
    sortDir?: "asc" | "desc";
    page?: number;
}): Promise<DelegatesPage> {
    const ctx = await loadMatchingContext(params.eventCode);

    const ids = new Set<string>();
    for (const a of ctx.attendees) {
        if (a.role === "delegate" && a.salesforceId && !matchExclusion(ctx, a)) ids.add(a.salesforceId);
    }
    for (const [id, c] of ctx.counts) if (c.d2d > 0) ids.add(id);

    let rows = [...ids]
        .map((id) => delegateRow(ctx, id))
        .filter((r): r is DelegateRow => !!r);

    // Search matches the name or company, case-insensitive.
    const q = (params.q ?? "").trim().toLowerCase();
    if (q) {
        rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.company.toLowerCase().includes(q));
    }

    const dir = params.sortDir === "desc" ? -1 : 1;
    rows.sort((a, b) => {
        switch (params.sortField) {
            case "company":
                return dir * a.company.localeCompare(b.company);
            case "s2dCount":
                return dir * (a.s2dCount - b.s2dCount);
            case "d2dCount":
                return dir * (a.d2dCount - b.d2dCount);
            default:
                return dir * a.name.localeCompare(b.name);
        }
    });

    const total = rows.length;
    const { page, pageSize, pageCount, offset } = paginate(total, params);
    return { rows: rows.slice(offset, offset + pageSize), total, page, pageSize, pageCount };
}

/**
 * The warning to show before a D2D run, when no S2D meetings exist yet or roundtables are already grouped.
 *
 * @param {string} eventCode - The event.
 * @returns {Promise<string | null>} The warning, or null.
 */
export async function d2dRunWarning(eventCode: string): Promise<string | null> {
    const ctx = await loadMatchingContext(eventCode);
    let s2d = 0;
    for (const c of ctx.counts.values()) s2d += c.s2d;
    return d2dOrderWarning(s2d, seatedDelegateIds(ctx.seatRows).size);
}

/**
 * Result of a D2D run.
 * A run that stops before changing anything returns a message instead of a report.
 */
export type RunD2DResult = { ok: true; report: D2DReport } | { ok: false; error: string };

/**
 * Runs D2D matching for an event and replaces its unpushed D2D meetings with the fresh output.
 * Pushed D2D meetings are kept, and count toward caps and busy times.
 * Every S2D meeting, every roundtable seat and every Cvent appointment counts as busy time, so no delegate is double-booked.
 * Delegates seated at a roundtable aren't paired, since roundtables are for delegates with no meetings.
 * The run still goes ahead when no S2D meetings exist or roundtables are already grouped, but the report warns about it.
 *
 * It stops before changing anything when no delegates loaded or no slot is mapped to delegate_delegate.
 *
 * @param {string} eventCode - The event.
 * @returns {Promise<RunD2DResult>} The run report, or why it stopped.
 */
export async function runD2DForEvent(eventCode: string): Promise<RunD2DResult> {
    const ctx = await loadMatchingContext(eventCode);
    const { scheduleData } = ctx;

    if (!ctx.attendees.some((a) => a.role === "delegate")) {
        return { ok: false, error: NO_DELEGATES_MESSAGE };
    }
    const d2dSlots = scheduleData.timeslots.filter((t) => t.kind === "delegate_delegate");
    if (d2dSlots.length === 0) return { ok: false, error: NO_D2D_SLOTS_MESSAGE };

    // Pushed D2D meetings stay. Unpushed ones are replaced, so they don't count.
    const s2dRows = ctx.rows.filter((r) => r.kind === "sponsor_delegate");
    const keptD2D = ctx.rows.filter((r) => r.kind === "delegate_delegate" && r.cventAppointmentId);

    const s2dCountById = new Map<string, number>();
    let s2dTotal = 0;
    for (const [id, c] of ctx.counts) {
        s2dCountById.set(id, c.s2d);
        s2dTotal += c.s2d;
    }
    const warnings: string[] = [];
    const seatedIds = seatedDelegateIds(ctx.seatRows);
    const orderWarning = d2dOrderWarning(s2dTotal, seatedIds.size);
    if (orderWarning) warnings.push(orderWarning);
    if (!ctx.appointments) {
        warnings.push("Cvent's appointment list couldn't be read, so appointments made in Cvent weren't counted as busy.");
    }

    const result = runD2DMatching({
        attendees: ctx.attendees,
        s2dCountById,
        existingD2D: keptD2DMeetings(keptD2D, ctx.cventOnly, scheduleData.timeslots),
        busyById: mergeBusyTimes(
            busyStartTimes([...s2dRows, ...keptD2D], ctx.slotById, ctx.appointments ?? [], ctx.attendees),
            seatedBusyTimes(ctx.seatRows, ctx.roundtableRows, ctx.slotById),
        ),
        seatedIds,
        timeslots: d2dSlots,
        slotRemaining: slotRoomLeft(d2dSlots, scheduleData.locations, ctx.appointments, keptD2D),
        settings: ctx.settings.d2d,
    });

    // Replace the unpushed D2D meetings. Sponsor meetings and pushed D2D meetings are left alone.
    await db
        .delete(scheduledMeetings)
        .where(
            and(
                eq(scheduledMeetings.eventCode, eventCode),
                eq(scheduledMeetings.source, "portal"),
                eq(scheduledMeetings.kind, "delegate_delegate"),
                isNull(scheduledMeetings.cventAppointmentId),
            ),
        );
    if (result.meetings.length > 0) {
        const toInsert: NewScheduledMeeting[] = result.meetings.map((m) => ({
            id: m.id,
            eventCode,
            kind: "delegate_delegate",
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

    revalidatePath("/admin/delegate-meetings", "layout");
    return {
        ok: true,
        report: buildD2DReport({
            eventCode,
            generatedAt: new Date().toISOString(),
            attendees: ctx.attendees,
            result,
            kept: keptD2D.length,
            warnings,
        }),
    };
}

/**
 * Loads an event's portal D2D meetings.
 *
 * @param {string} eventCode - The event.
 * @returns The rows.
 */
async function portalD2DRows(eventCode: string) {
    return db
        .select()
        .from(scheduledMeetings)
        .where(
            and(
                eq(scheduledMeetings.eventCode, eventCode),
                eq(scheduledMeetings.source, "portal"),
                eq(scheduledMeetings.kind, "delegate_delegate"),
            ),
        );
}

/**
 * Pushes every D2D meeting that is not pushed or was changed since its last push.
 *
 * @param {string} eventCode - The event.
 * @returns {Promise<SyncReport>} The push report.
 */
export async function pushAllD2DForEvent(eventCode: string): Promise<SyncReport> {
    const rows = await portalD2DRows(eventCode);
    const toPush = rows.filter(needsSync);
    const summary = await pushDelegateMeetingRows(eventCode, toPush);
    revalidatePath("/admin/delegate-meetings", "layout");
    return buildSyncReport({
        eventCode,
        generatedAt: new Date().toISOString(),
        totalPortalMeetings: rows.length,
        alreadySynced: rows.length - toPush.length,
        results: summary.results,
    });
}

/**
 * Deletes every D2D meeting not pushed to Cvent. Pushed ones and sponsor meetings are kept.
 *
 * @param {string} eventCode - The event.
 * @returns {Promise<MaintenanceReport>} How many were deleted.
 */
export async function clearUnsyncedD2DForEvent(eventCode: string): Promise<MaintenanceReport> {
    const deleted = await db
        .delete(scheduledMeetings)
        .where(
            and(
                eq(scheduledMeetings.eventCode, eventCode),
                eq(scheduledMeetings.source, "portal"),
                eq(scheduledMeetings.kind, "delegate_delegate"),
                isNull(scheduledMeetings.cventAppointmentId),
            ),
        )
        .returning({ id: scheduledMeetings.id });
    revalidatePath("/admin/delegate-meetings", "layout");
    return {
        kind: "clear_unsynced",
        eventCode,
        generatedAt: new Date().toISOString(),
        deleted: deleted.length,
    };
}

/**
 * Cancels the Cvent appointment behind every synced D2D meeting and unlinks it, keeping the meeting.
 * Cancelling suppresses Cvent's emails when CVENT_SUPPRESS_NOTIFICATIONS is set, as for sponsor meetings.
 *
 * @param {string} eventCode - The event.
 * @returns {Promise<MaintenanceReport>} Counts plus per-meeting detail.
 */
export async function unpushAllD2DForEvent(eventCode: string): Promise<MaintenanceReport> {
    const [syncedRows, ctx] = await Promise.all([
        db
            .select()
            .from(scheduledMeetings)
            .where(
                and(
                    eq(scheduledMeetings.eventCode, eventCode),
                    eq(scheduledMeetings.source, "portal"),
                    eq(scheduledMeetings.kind, "delegate_delegate"),
                    isNotNull(scheduledMeetings.cventAppointmentId),
                ),
            ),
        loadMatchingContext(eventCode),
    ]);
    const nameById = new Map(ctx.attendees.map((a) => [a.salesforceId, a.name]));
    const outcome = await unpushMeetingRows(
        eventCode,
        syncedRows,
        (row) => `${nameById.get(row.attendeeA) ?? row.attendeeA} & ${nameById.get(row.attendeeB) ?? row.attendeeB}`,
    );
    revalidatePath("/admin/delegate-meetings", "layout");
    return {
        kind: "unpush_synced",
        eventCode,
        generatedAt: new Date().toISOString(),
        total: syncedRows.length,
        unpushed: outcome.unpushed,
        alreadyGone: outcome.alreadyGone,
        failed: outcome.failures.length,
        failures: outcome.failures,
        notes: outcome.notes,
    };
}
