"use server";

import { and, asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { roundtableSeats, roundtables, type RoundtableSeatRole } from "@/lib/db/schema";
import { getSyncStatus, type SyncStatus } from "@/lib/cvent/syncStatus";
import { pushRoundtableRows, roundtableLabel, unpushRoundtableRows } from "@/lib/cvent/roundtablePush";
import { buildSyncReport, type SyncReport } from "@/lib/cvent/syncReport";
import { loadEventScheduleData } from "@/lib/cvent/mapper";
import { loadMatchingContext, type MatchingContext } from "@/lib/matching/data";
import { busyStartTimes } from "@/lib/matching/delegateMeetings";
import { buildAnswerScales } from "@/lib/matching/questions";
import {
    checkSeatMove,
    explainSeat,
    roundtableExclusion,
    roundtableHostId,
    summarizeTable,
} from "@/lib/matching/roundtables";
import type { Attendee } from "@/types";

// ---------------------------------------------------------------------------
// Server actions for /admin/roundtables/[roundtableId], one roundtable.
//
// Admins enter the theme title, edit the description, and move delegates between tables,
// alternates and the unassigned list. Every move re-checks the same-company rule and the
// delegate's busy time, and warnings are shown before saving.
// Editing a table sets its lastModifiedAt, so a pushed table reads as Modified until it is pushed again.
// ---------------------------------------------------------------------------

/** One seated delegate or alternate on the roundtable page. */
export type SeatRow = {
    delegateId: string;
    name: string;
    company: string;
    title: string;
    role: RoundtableSeatRole;
    position: number;
    /** Their score with the table's seated delegates, 0 to 100. */
    score: number;
    /** What they share with the table's seated delegates. */
    reason: string;
    /** True for the seated delegate who hosts the table in Cvent. */
    host: boolean;
};

/** The roundtable's own details. */
export type RoundtableInfo = {
    id: string;
    location: string;
    startTime: string | null;
    day: number;
    themeTitle: string;
    /** Exactly what Cvent gets as the appointment's description. Empty when cleared. */
    description: string;
    seats: number;
    summary: string;
    averageScore: number;
    short: boolean;
    weak: boolean;
    syncStatus: SyncStatus;
};

/** Another table a delegate can be moved to. */
export type TableChoice = { id: string; label: string };

/** Everything the roundtable page shows. */
export type RoundtableDetail = {
    table: RoundtableInfo;
    seated: SeatRow[];
    alternates: SeatRow[];
    /** Delegates who qualify but have no seat anywhere. */
    unassigned: { delegateId: string; name: string; company: string; score: number; reason: string }[];
    /** Every table, this one included, for the move menus. */
    tables: TableChoice[];
    timezone: string;
};

/**
 * A table's label for menus, its location name.
 *
 * @param {MatchingContext} ctx - The event's matching data.
 * @param {{ locationId: string | null }} row - The roundtable row.
 * @returns {string} The label.
 */
function tableLabel(ctx: MatchingContext, row: { locationId: string | null }): string {
    return (row.locationId ? ctx.scheduleData.locationById.get(row.locationId)?.name : undefined) ?? "Unknown location";
}

/**
 * Loads one roundtable with its seats, alternates and the unassigned delegates.
 * Returns null when the roundtable isn't in this event, which the page turns into a 404.
 *
 * @param {{ roundtableId: string; eventCode: string }} params - The roundtable and event.
 * @returns {Promise<RoundtableDetail | null>} The page data.
 */
export async function getRoundtableDetail(params: {
    roundtableId: string;
    eventCode: string;
}): Promise<RoundtableDetail | null> {
    const ctx = await loadMatchingContext(params.eventCode);
    const row = ctx.roundtableRows.find((r) => r.id === params.roundtableId);
    if (!row) return null;
    const settings = ctx.settings.roundtables;
    const byId = new Map(ctx.attendees.map((a) => [a.salesforceId, a]));
    const scales = buildAnswerScales(ctx.attendees.filter((a) => a.role === "delegate").map((a) => a.profile));

    const mine = ctx.seatRows
        .filter((s) => s.roundtableId === row.id)
        .sort((x, y) => x.position - y.position);
    const seatedPeople = mine
        .filter((s) => s.role === "seated")
        .map((s) => byId.get(s.delegateId))
        .filter((a): a is Attendee => !!a);

    const hostId = roundtableHostId(mine.filter((s) => s.role === "seated").map((s) => s.delegateId));
    /**
     * Builds a seat row, explained against the table's other seated delegates.
     *
     * @param {(typeof mine)[number]} s - The seat.
     * @returns {SeatRow} The row.
     */
    const toRow = (s: (typeof mine)[number]): SeatRow => {
        const a = byId.get(s.delegateId);
        const others = seatedPeople.filter((p) => p.salesforceId !== s.delegateId).map((p) => p.profile);
        const explained = a ? explainSeat(a.profile, others, settings.questions, scales) : { score: 0, reason: "" };
        return {
            delegateId: s.delegateId,
            name: a?.name ?? s.delegateId,
            company: a?.company ?? "",
            title: a?.title ?? "",
            role: s.role,
            position: s.position,
            ...explained,
            host: s.role === "seated" && s.delegateId === hostId,
        };
    };

    const placed = new Set(ctx.seatRows.map((s) => s.delegateId));
    const unassigned = ctx.attendees
        .filter((a) => a.role === "delegate" && a.salesforceId && !placed.has(a.salesforceId))
        .filter((a) => roundtableExclusion(a, ctx.counts) === null)
        .map((a) => ({
            delegateId: a.salesforceId,
            name: a.name,
            company: a.company,
            ...explainSeat(a.profile, seatedPeople.map((p) => p.profile), settings.questions, scales),
        }))
        .sort((x, y) => y.score - x.score || x.name.localeCompare(y.name));

    const summary = summarizeTable(seatedPeople, settings, scales);
    const ts = ctx.scheduleData.timeslotById.get(row.timeslotId);
    return {
        table: {
            id: row.id,
            location: tableLabel(ctx, row),
            startTime: ts?.startTime ?? null,
            day: ts?.day ?? 0,
            themeTitle: row.themeTitle ?? "",
            description: row.description ?? "",
            seats: settings.seatsPerTable,
            summary: summary.summary,
            averageScore: summary.averageScore,
            short: summary.short,
            weak: summary.weak,
            syncStatus: getSyncStatus(row),
        },
        seated: mine.filter((s) => s.role === "seated").map(toRow),
        alternates: mine.filter((s) => s.role === "alternate").map(toRow),
        unassigned,
        tables: ctx.roundtableRows
            .map((r) => {
                const t = ctx.scheduleData.timeslotById.get(r.timeslotId);
                return { id: r.id, label: tableLabel(ctx, r), sort: `${t?.day ?? 9}|${t?.startTime ?? ""}` };
            })
            .sort((x, y) => x.sort.localeCompare(y.sort) || x.label.localeCompare(y.label))
            .map(({ id, label }) => ({ id, label })),
        timezone: ctx.scheduleData.timezone,
    };
}

/** The result of a save on the roundtable page. */
export type RoundtableSaveResult = { ok: true } | { ok: false; error: string };

/**
 * Saves a roundtable's theme title and description.
 * Both are trimmed. A blank theme is stored as empty.
 * A cleared description is stored as an empty string and pushed to Cvent empty, never replaced by the default.
 * The save marks the table as edited, so a pushed table reads as Modified.
 *
 * @param {{ roundtableId: string; themeTitle: string; description: string }} params - The table and its text.
 * @returns {Promise<RoundtableSaveResult>} Success, or why nothing was saved.
 */
export async function saveRoundtableText(params: {
    roundtableId: string;
    themeTitle: string;
    description: string;
}): Promise<RoundtableSaveResult> {
    const themeTitle = params.themeTitle.trim();
    const description = params.description.trim();
    if (themeTitle.length > 200) return { ok: false, error: "Error: the theme title must be 200 characters or fewer" };
    if (description.length > 2000) {
        return { ok: false, error: "Error: the description must be 2,000 characters or fewer" };
    }
    const updated = await db
        .update(roundtables)
        .set({ themeTitle: themeTitle || null, description, lastModifiedAt: new Date() })
        .where(eq(roundtables.id, params.roundtableId))
        .returning({ id: roundtables.id });
    if (updated.length === 0) return { ok: false, error: "Error: roundtable not found" };
    revalidatePath("/admin/roundtables", "layout");
    return { ok: true };
}

/** Where a delegate is being moved: a table as a seat or alternate, or off every table. */
export type MoveTarget = { roundtableId: string; role: RoundtableSeatRole } | null;

/**
 * The result of a move.
 * A move with warnings isn't saved until the admin confirms it.
 */
export type MoveResult =
    | { ok: true }
    | { ok: false; error: string }
    | { ok: false; needsConfirm: true; warnings: string[] };

/**
 * Renumbers one table's seats or alternates 1, 2, 3 in their current order.
 *
 * @param {string} roundtableId - The table.
 * @param {RoundtableSeatRole} role - Seats or alternates.
 */
async function renumber(roundtableId: string, role: RoundtableSeatRole): Promise<void> {
    const seats = await db
        .select({ id: roundtableSeats.id, position: roundtableSeats.position })
        .from(roundtableSeats)
        .where(and(eq(roundtableSeats.roundtableId, roundtableId), eq(roundtableSeats.role, role)))
        .orderBy(asc(roundtableSeats.position), asc(roundtableSeats.id));
    for (let i = 0; i < seats.length; i++) {
        if (seats[i].position !== i + 1) {
            await db.update(roundtableSeats).set({ position: i + 1 }).where(eq(roundtableSeats.id, seats[i].id));
        }
    }
}

/**
 * Marks tables as edited, so a pushed table reads as Modified.
 *
 * @param {string[]} ids - The tables.
 */
async function touch(ids: string[]): Promise<void> {
    for (const id of new Set(ids)) {
        await db.update(roundtables).set({ lastModifiedAt: new Date() }).where(eq(roundtables.id, id));
    }
}

/**
 * Checks a move against the same-company rule, the delegate's busy time and the table's seats.
 *
 * @param {MatchingContext} ctx - The event's matching data.
 * @param {Attendee} delegate - The delegate being moved.
 * @param {{ roundtableId: string; role: RoundtableSeatRole }} to - Where they are going.
 * @param {string[]} [leaving] - Delegates leaving that table in the same change, such as in a swap.
 * @returns {{ errors: string[]; warnings: string[] } | null} The check, or null when the table isn't found.
 */
function checkMove(
    ctx: MatchingContext,
    delegate: Attendee,
    to: { roundtableId: string; role: RoundtableSeatRole },
    leaving: string[] = [],
): { errors: string[]; warnings: string[] } | null {
    const table = ctx.roundtableRows.find((r) => r.id === to.roundtableId);
    const slot = table ? ctx.scheduleData.timeslotById.get(table.timeslotId) : undefined;
    if (!table) return null;
    const byId = new Map(ctx.attendees.map((a) => [a.salesforceId, a]));
    const seated = ctx.seatRows
        .filter((s) => s.roundtableId === table.id && s.role === "seated" && !leaving.includes(s.delegateId))
        .map((s) => byId.get(s.delegateId))
        .filter((a): a is Attendee => !!a);
    // A pushed roundtable's own Cvent appointment doesn't make its delegates busy.
    // The seats in the portal are the truth for roundtables, and a move takes the delegate off their current table.
    const roundtableAppointmentIds = new Set(
        ctx.roundtableRows.map((r) => r.cventAppointmentId).filter((id): id is string => !!id),
    );
    const appointments = (ctx.appointments ?? []).filter((a) => !a.id || !roundtableAppointmentIds.has(a.id));
    const busy = busyStartTimes(ctx.rows, ctx.scheduleData.timeslotById, appointments, ctx.attendees);
    const check = checkSeatMove({
        delegate,
        role: to.role,
        seated,
        seats: ctx.settings.roundtables.seatsPerTable,
        tableStart: slot?.startTime ?? "",
        busy: busy.get(delegate.salesforceId) ?? new Set(),
        exclusion: roundtableExclusion(delegate, ctx.counts),
    });
    if (!slot) check.warnings.push("This table's timeslot is no longer in Cvent.");
    return check;
}

/**
 * Moves a delegate onto a table as a seat or alternate, or off every table.
 * A seat is refused when someone at the table is from their company, when they are busy then, or when the table is full.
 * Warnings, such as a delegate who now has a meeting, are returned first and only saved once confirmed.
 *
 * @param {{ eventCode: string; delegateId: string; to: MoveTarget; confirmed?: boolean }} params - The delegate, where to, and whether the admin confirmed the warnings.
 * @returns {Promise<MoveResult>} Success, a refusal, or the warnings to confirm.
 */
export async function moveDelegate(params: {
    eventCode: string;
    delegateId: string;
    to: MoveTarget;
    confirmed?: boolean;
}): Promise<MoveResult> {
    const ctx = await loadMatchingContext(params.eventCode);
    const delegate = ctx.attendees.find((a) => a.salesforceId === params.delegateId && a.role === "delegate");
    if (!delegate) return { ok: false, error: "Error: delegate not found" };
    const current = ctx.seatRows.find((s) => s.delegateId === params.delegateId);

    if (params.to) {
        if (current && current.roundtableId === params.to.roundtableId && current.role === params.to.role) {
            return { ok: true };
        }
        const check = checkMove(ctx, delegate, params.to, current ? [current.delegateId] : []);
        if (!check) return { ok: false, error: "Error: roundtable not found" };
        if (check.errors.length) return { ok: false, error: `Error: ${check.errors.join(" ")}` };
        if (check.warnings.length && !params.confirmed) {
            return { ok: false, needsConfirm: true, warnings: check.warnings };
        }
    }

    // A move to the end of the target's seats or alternates.
    const position =
        params.to
            ? Math.max(
                  0,
                  ...ctx.seatRows
                      .filter((s) => s.roundtableId === params.to!.roundtableId && s.role === params.to!.role)
                      .map((s) => s.position),
              ) + 1
            : 0;

    if (current && params.to) {
        await db
            .update(roundtableSeats)
            .set({ roundtableId: params.to.roundtableId, role: params.to.role, position, reason: null, score: null })
            .where(eq(roundtableSeats.id, current.id));
    } else if (current) {
        await db.delete(roundtableSeats).where(eq(roundtableSeats.id, current.id));
    } else if (params.to) {
        await db.insert(roundtableSeats).values({
            eventCode: params.eventCode,
            roundtableId: params.to.roundtableId,
            delegateId: params.delegateId,
            role: params.to.role,
            position,
            reason: null,
            score: null,
        });
    }

    if (current) await renumber(current.roundtableId, current.role);
    const changed = [current?.roundtableId, params.to?.roundtableId].filter((id): id is string => !!id);
    await touch(changed);
    revalidatePath("/admin/roundtables", "layout");
    return { ok: true };
}

/**
 * Swaps an alternate into a seated delegate's seat at the same table.
 * The seated delegate becomes an alternate in the alternate's place.
 * The swap is checked against the same-company rule and the alternate's busy time.
 *
 * @param {{ eventCode: string; roundtableId: string; alternateId: string; seatedId: string; confirmed?: boolean }} params
 *   The table, the alternate, the seated delegate, and whether the admin confirmed the warnings.
 * @returns {Promise<MoveResult>} Success, a refusal, or the warnings to confirm.
 */
export async function swapAlternate(params: {
    eventCode: string;
    roundtableId: string;
    alternateId: string;
    seatedId: string;
    confirmed?: boolean;
}): Promise<MoveResult> {
    const ctx = await loadMatchingContext(params.eventCode);
    const alt = ctx.seatRows.find(
        (s) => s.delegateId === params.alternateId && s.roundtableId === params.roundtableId && s.role === "alternate",
    );
    const seat = ctx.seatRows.find(
        (s) => s.delegateId === params.seatedId && s.roundtableId === params.roundtableId && s.role === "seated",
    );
    const delegate = ctx.attendees.find((a) => a.salesforceId === params.alternateId);
    if (!alt || !seat || !delegate) return { ok: false, error: "Error: that alternate or seat is no longer at this table" };

    const check = checkMove(ctx, delegate, { roundtableId: params.roundtableId, role: "seated" }, [params.seatedId]);
    if (!check) return { ok: false, error: "Error: roundtable not found" };
    if (check.errors.length) return { ok: false, error: `Error: ${check.errors.join(" ")}` };
    if (check.warnings.length && !params.confirmed) return { ok: false, needsConfirm: true, warnings: check.warnings };

    await db
        .update(roundtableSeats)
        .set({ role: "seated", position: seat.position, reason: null, score: null })
        .where(eq(roundtableSeats.id, alt.id));
    await db
        .update(roundtableSeats)
        .set({ role: "alternate", position: alt.position, reason: null, score: null })
        .where(eq(roundtableSeats.id, seat.id));
    await touch([params.roundtableId]);
    revalidatePath("/admin/roundtables", "layout");
    return { ok: true };
}

/**
 * Pushes one roundtable to Cvent and returns a one-table sync report.
 * A table already in Cvent is replaced, or updated in place when the replacement collides with it.
 * A table with no theme title is reported as failed with a message, and nothing is sent.
 * The event's other tables are passed along, so a host still held by another table in Cvent is named.
 *
 * @param {{ roundtableId: string; eventCode: string }} params - The table and event.
 * @returns {Promise<SyncReport>} The push report.
 */
export async function pushRoundtable(params: { roundtableId: string; eventCode: string }): Promise<SyncReport> {
    const [eventTables, seats] = await Promise.all([
        db.select().from(roundtables).where(eq(roundtables.eventCode, params.eventCode)),
        db.select().from(roundtableSeats).where(eq(roundtableSeats.roundtableId, params.roundtableId)),
    ]);
    const rows = eventTables.filter((t) => t.id === params.roundtableId);
    const summary = await pushRoundtableRows(params.eventCode, rows, seats, eventTables);
    revalidatePath("/admin/roundtables", "layout");
    return buildSyncReport({
        eventCode: params.eventCode,
        generatedAt: new Date().toISOString(),
        totalPortalMeetings: rows.length,
        alreadySynced: 0,
        results: summary.results,
    });
}

/**
 * Cancels one roundtable's Cvent appointment and unlinks it, keeping the table, its seats and its text.
 * Cancelling suppresses Cvent's emails when CVENT_SUPPRESS_NOTIFICATIONS is set.
 * An appointment already gone in Cvent is unlinked anyway.
 *
 * @param {{ roundtableId: string; eventCode: string }} params - The table and event.
 * @returns {Promise<RoundtableSaveResult>} Success, or why the table is still linked.
 */
export async function unpushRoundtable(params: { roundtableId: string; eventCode: string }): Promise<RoundtableSaveResult> {
    const [[row], scheduleData] = await Promise.all([
        db
            .select()
            .from(roundtables)
            .where(and(eq(roundtables.id, params.roundtableId), eq(roundtables.eventCode, params.eventCode)))
            .limit(1),
        loadEventScheduleData(params.eventCode),
    ]);
    if (!row) return { ok: false, error: "Error: roundtable not found" };
    if (!row.cventAppointmentId) return { ok: false, error: "Error: this roundtable isn't in Cvent" };
    const location = (row.locationId ? scheduleData.locationById.get(row.locationId)?.name : undefined) ?? "Unknown location";
    const outcome = await unpushRoundtableRows(params.eventCode, [row], (r) => roundtableLabel(r, location));
    revalidatePath("/admin/roundtables", "layout");
    if (outcome.failures.length > 0) {
        return { ok: false, error: `Error: Cvent didn't cancel the appointment, so the table is still linked. ${outcome.failures[0].detail}` };
    }
    return { ok: true };
}
