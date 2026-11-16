"use server";

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import {
    roundtableSeats,
    roundtables,
    type NewRoundtable,
    type NewRoundtableSeat,
    type RoundtableRow,
    type RoundtableSeatRow,
} from "@/lib/db/schema";
import { loadMatchingContext, type MatchingContext } from "@/lib/matching/data";
import { NO_DELEGATES_MESSAGE } from "@/lib/matching/d2d";
import { buildAnswerScales } from "@/lib/matching/questions";
import {
    roundtableExclusion,
    roundtableOrderWarning,
    roundtableSlots,
    runRoundtableGrouping,
    summarizeTable,
} from "@/lib/matching/roundtables";
import { buildRoundtableReport, type RoundtableReport } from "@/lib/matching/roundtableReport";
import { getSyncStatus, type SyncStatus } from "@/lib/cvent/syncStatus";
import { needsSync } from "@/lib/cvent/push";
import { pushRoundtableRows, roundtableLabel, unpushRoundtableRows } from "@/lib/cvent/roundtablePush";
import { buildSyncReport, type SyncReport } from "@/lib/cvent/syncReport";
import { loadEventScheduleData } from "@/lib/cvent/mapper";
import type { MaintenanceReport } from "@/app/admin/meetings/actions";

// ---------------------------------------------------------------------------
// Server actions for /admin/roundtables, the roundtable list page.
//
// Each Cvent timeslot mapped to delegate_group is one table.
// Running the grouping replaces the tables not pushed to Cvent, including their themes.
// Push All and Unpush All work as on the sponsor and delegate meeting pages (see lib/cvent/roundtablePush.ts).
// ---------------------------------------------------------------------------

/** One roundtable row in the list. */
export type RoundtableListRow = {
    id: string;
    /** The table's location name. */
    location: string;
    day: number;
    startTime: string | null;
    themeTitle: string | null;
    seated: number;
    seats: number;
    alternates: number;
    /** What the seated delegates share, in one line. */
    summary: string;
    short: boolean;
    weak: boolean;
    syncStatus: SyncStatus;
};

/** A delegate in the unassigned list. */
export type DelegateBrief = { delegateId: string; name: string; company: string };

/** A delegate_group slot in Cvent, so admins can check every table is set up. */
export type CventTable = { timeslotId: string; location: string; day: number; startTime: string; hasRoundtable: boolean };

/** Everything the Roundtables list shows. */
export type RoundtablesOverview = {
    rows: RoundtableListRow[];
    unassigned: DelegateBrief[];
    cventTables: CventTable[];
    /** Shown before a run when no D2D meetings exist yet. */
    orderWarning: string | null;
};

/**
 * Lists the delegates who qualify for a roundtable but have no seat and aren't an alternate.
 *
 * @param {MatchingContext} ctx - The event's matching data.
 * @returns {DelegateBrief[]} The unassigned delegates, by name.
 */
function unassignedDelegates(ctx: MatchingContext): DelegateBrief[] {
    const placed = new Set(ctx.seatRows.map((s) => s.delegateId));
    return ctx.attendees
        .filter((a) => a.role === "delegate" && a.salesforceId && !placed.has(a.salesforceId))
        .filter((a) => roundtableExclusion(a, ctx.counts) === null)
        .map((a) => ({ delegateId: a.salesforceId, name: a.name, company: a.company }))
        .sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * Loads an event's roundtables, its unassigned delegates and its delegate_group slots in Cvent.
 *
 * @param {string} eventCode - The event.
 * @returns {Promise<RoundtablesOverview>} The list data.
 */
export async function listRoundtables(eventCode: string): Promise<RoundtablesOverview> {
    const ctx = await loadMatchingContext(eventCode);
    const { locationById } = ctx.scheduleData;
    // A pushed table whose time Cvent no longer lists gets it from its appointment.
    const timeslotById = ctx.slotById;
    const byId = new Map(ctx.attendees.map((a) => [a.salesforceId, a]));
    const scales = buildAnswerScales(ctx.attendees.filter((a) => a.role === "delegate").map((a) => a.profile));
    const settings = ctx.settings.roundtables;

    const rows: RoundtableListRow[] = ctx.roundtableRows.map((r) => {
        const seats = ctx.seatRows.filter((s) => s.roundtableId === r.id);
        const seated = seats
            .filter((s) => s.role === "seated")
            .map((s) => byId.get(s.delegateId))
            .filter((a): a is NonNullable<typeof a> => !!a);
        const summary = summarizeTable(seated, settings, scales);
        const ts = timeslotById.get(r.timeslotId);
        return {
            id: r.id,
            location: (r.locationId ? locationById.get(r.locationId)?.name : undefined) ?? "Unknown location",
            day: ts?.day ?? 0,
            startTime: ts?.startTime ?? null,
            themeTitle: r.themeTitle,
            seated: seats.filter((s) => s.role === "seated").length,
            seats: settings.seatsPerTable,
            alternates: seats.filter((s) => s.role === "alternate").length,
            summary: summary.summary,
            short: summary.short,
            weak: summary.weak,
            syncStatus: getSyncStatus(r),
        };
    });
    rows.sort((x, y) => x.day - y.day || (x.startTime ?? "").localeCompare(y.startTime ?? "") || x.location.localeCompare(y.location));

    const withRow = new Set(ctx.roundtableRows.map((r) => r.timeslotId));
    // A pushed table's booked slot can drop out of Cvent's list, so it is added back from its appointment.
    const listedIds = new Set(ctx.scheduleData.timeslots.map((t) => t.id));
    const bookedTableSlots = ctx.roundtableRows
        .filter((r) => !listedIds.has(r.timeslotId))
        .map((r) => ctx.slotById.get(r.timeslotId))
        .filter((t): t is NonNullable<typeof t> => !!t);
    const cventTables = roundtableSlots([...ctx.scheduleData.timeslots, ...bookedTableSlots]).map((t) => ({
        timeslotId: t.id,
        location: (t.locationId ? locationById.get(t.locationId)?.name : undefined) ?? "Unknown location",
        day: t.day,
        startTime: t.startTime,
        hasRoundtable: withRow.has(t.id),
    }));

    let d2d = 0;
    for (const c of ctx.counts.values()) d2d += c.d2d;
    return { rows, unassigned: unassignedDelegates(ctx), cventTables, orderWarning: roundtableOrderWarning(d2d) };
}

/** Shown when a roundtable run stops because no slot is mapped to delegate_group. */
const NO_GROUP_SLOTS_MESSAGE =
    "No Delegate Group slots were found for this event, so nothing was changed. " +
    "Map the roundtable appointment type to Delegate group in Event Settings and check that Cvent is reachable.";

/** Result of a roundtable run, or why it stopped before changing anything. */
export type RunRoundtablesResult = { ok: true; report: RoundtableReport } | { ok: false; error: string };

/**
 * Runs roundtable grouping for an event.
 * It replaces every roundtable not pushed to Cvent, with its seats, alternates, theme and description.
 * Each new table starts with the default host note as its description.
 * Pushed roundtables and their delegates are left alone.
 * The run still goes ahead when no D2D meetings exist, but the report warns about it.
 * It stops before changing anything when no delegates loaded or no slot is mapped to delegate_group.
 *
 * @param {string} eventCode - The event.
 * @returns {Promise<RunRoundtablesResult>} The run report, or why it stopped.
 */
export async function runRoundtablesForEvent(eventCode: string): Promise<RunRoundtablesResult> {
    const ctx = await loadMatchingContext(eventCode);
    if (!ctx.attendees.some((a) => a.role === "delegate")) return { ok: false, error: NO_DELEGATES_MESSAGE };
    if (roundtableSlots(ctx.scheduleData.timeslots).length === 0) return { ok: false, error: NO_GROUP_SLOTS_MESSAGE };

    const pushed = ctx.roundtableRows.filter((r) => r.cventAppointmentId);
    const pushedIds = new Set(pushed.map((r) => r.id));

    const warnings: string[] = [];
    let d2d = 0;
    for (const c of ctx.counts.values()) d2d += c.d2d;
    const orderWarning = roundtableOrderWarning(d2d);
    if (orderWarning) warnings.push(orderWarning);
    if (!ctx.appointments) {
        warnings.push("Cvent's appointment list couldn't be read, so meetings made in Cvent weren't counted.");
    }

    const result = runRoundtableGrouping({
        attendees: ctx.attendees,
        counts: ctx.counts,
        timeslots: ctx.scheduleData.timeslots,
        skipTimeslotIds: new Set(pushed.map((r) => r.timeslotId)),
        takenIds: new Set(ctx.seatRows.filter((s) => pushedIds.has(s.roundtableId)).map((s) => s.delegateId)),
        settings: ctx.settings.roundtables,
    });

    // Replace the unpushed tables. The foreign key deletes their seats.
    // The delete checks cventAppointmentId itself, so a table pushed since the data was read is kept.
    await db
        .delete(roundtables)
        .where(and(eq(roundtables.eventCode, eventCode), isNull(roundtables.cventAppointmentId)))
        .returning({ id: roundtables.id });

    const now = Date.now();
    const tables: NewRoundtable[] = result.groups.map((g, i) => ({
        // A timestamp suffix keeps ids unique across runs, since Cvent never frees an appointment code.
        id: `rt-${String(i + 1).padStart(3, "0")}-${now}`,
        eventCode,
        timeslotId: g.timeslotId,
        locationId: g.locationId,
        themeTitle: null,
        description: g.description,
        cventAppointmentId: null,
        lastModifiedAt: null,
        lastPushedAt: null,
    }));
    const seats: NewRoundtableSeat[] = result.groups.flatMap((g, i) => [
        ...g.seated.map((s, p) => ({
            eventCode,
            roundtableId: tables[i].id,
            delegateId: s.delegateId,
            role: "seated" as const,
            position: p + 1,
            reason: s.reason,
            score: s.score,
        })),
        ...g.alternates.map((s, p) => ({
            eventCode,
            roundtableId: tables[i].id,
            delegateId: s.delegateId,
            role: "alternate" as const,
            position: p + 1,
            reason: s.reason,
            score: s.score,
        })),
    ]);
    if (tables.length > 0) await db.insert(roundtables).values(tables);
    if (seats.length > 0) await db.insert(roundtableSeats).values(seats);

    revalidatePath("/admin/roundtables", "layout");
    return {
        ok: true,
        report: buildRoundtableReport({
            eventCode,
            generatedAt: new Date().toISOString(),
            attendees: ctx.attendees,
            locationById: ctx.scheduleData.locationById,
            result,
            seats: ctx.settings.roundtables.seatsPerTable,
            kept: pushed.length,
            warnings,
        }),
    };
}

/**
 * Loads an event's roundtables and their seats, for push and unpush.
 *
 * @param {string} eventCode - The event.
 * @returns {Promise<{ rows: RoundtableRow[]; seats: RoundtableSeatRow[] }>} The tables and seats.
 */
async function roundtablesWithSeats(eventCode: string): Promise<{ rows: RoundtableRow[]; seats: RoundtableSeatRow[] }> {
    const [rows, seats] = await Promise.all([
        db.select().from(roundtables).where(eq(roundtables.eventCode, eventCode)),
        db.select().from(roundtableSeats).where(eq(roundtableSeats.eventCode, eventCode)),
    ]);
    return { rows, seats };
}

/**
 * Pushes every roundtable that is not pushed or was changed since its last push.
 * A table with no theme title is reported as failed with a message, and the others still go.
 *
 * @param {string} eventCode - The event.
 * @returns {Promise<SyncReport>} The push report.
 */
export async function pushAllRoundtablesForEvent(eventCode: string): Promise<SyncReport> {
    const { rows, seats } = await roundtablesWithSeats(eventCode);
    const toPush = rows.filter(needsSync);
    const summary = await pushRoundtableRows(eventCode, toPush, seats, rows);
    revalidatePath("/admin/roundtables", "layout");
    return buildSyncReport({
        eventCode,
        generatedAt: new Date().toISOString(),
        totalPortalMeetings: rows.length,
        alreadySynced: rows.length - toPush.length,
        results: summary.results,
    });
}

/**
 * Cancels the Cvent appointment behind every synced roundtable and unlinks it, keeping the table.
 * Cancelling suppresses Cvent's emails when CVENT_SUPPRESS_NOTIFICATIONS is set, as for meetings.
 *
 * @param {string} eventCode - The event.
 * @returns {Promise<MaintenanceReport>} Counts plus per-table detail.
 */
export async function unpushAllRoundtablesForEvent(eventCode: string): Promise<MaintenanceReport> {
    const [syncedRows, scheduleData] = await Promise.all([
        db
            .select()
            .from(roundtables)
            .where(and(eq(roundtables.eventCode, eventCode), isNotNull(roundtables.cventAppointmentId))),
        loadEventScheduleData(eventCode),
    ]);
    const outcome = await unpushRoundtableRows(eventCode, syncedRows, (row) =>
        roundtableLabel(
            row,
            (row.locationId ? scheduleData.locationById.get(row.locationId)?.name : undefined) ?? "Unknown location",
        ),
    );
    revalidatePath("/admin/roundtables", "layout");
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

/**
 * Deletes every roundtable not pushed to Cvent, with its seats and alternates.
 * The delete checks cventAppointmentId itself, so a table pushed in the meantime is kept.
 * The foreign key deletes the seats.
 *
 * @param {string} eventCode - The event.
 * @returns {Promise<MaintenanceReport>} How many roundtables were deleted.
 */
export async function clearUnsyncedRoundtablesForEvent(eventCode: string): Promise<MaintenanceReport> {
    const deleted = await db
        .delete(roundtables)
        .where(and(eq(roundtables.eventCode, eventCode), isNull(roundtables.cventAppointmentId)))
        .returning({ id: roundtables.id });
    revalidatePath("/admin/roundtables", "layout");
    return { kind: "clear_unsynced", eventCode, generatedAt: new Date().toISOString(), deleted: deleted.length };
}
