import type { Attendee, Location, Timeslot } from "@/types";
import type { ScheduledMeetingKind } from "@/lib/db/schema";
import type { CventExistingAppointment } from "@/lib/cvent/client";
import { appointmentsNotInPortal } from "@/lib/cvent/cventOnly";
import { slotRoomKey } from "@/lib/scheduling/helpers";
import type { ExistingD2D } from "./d2d";
import { startMs } from "./d2d";

// ---------------------------------------------------------------------------
// Each delegate's meetings, from the portal and from Cvent.
//
// The D2D and roundtable runs and the Delegate Meetings pages all need the same counts and busy times.
// Cvent is the source of truth, so appointments only in Cvent count too.
// An appointment only in Cvent with a sponsor rep in it counts as an S2D meeting.
// One with only delegates counts as a D2D meeting, since delegates can book each other in the Cvent app.
//
// Pure, so it can be tested without the database or Cvent.
// ---------------------------------------------------------------------------

/** The parts of a scheduled_meetings row these helpers read. */
export type MeetingRef = {
    kind: ScheduledMeetingKind;
    attendeeA: string;
    attendeeB: string;
    timeslotId: string;
    cventAppointmentId: string | null;
};

/** One delegate's meeting counts. */
export type DelegateCounts = {
    /** S2D meetings, in the portal and only in Cvent. */
    s2d: number;
    /** D2D meetings, in the portal and only in Cvent. */
    d2d: number;
};

/** A Cvent appointment only in Cvent, with the delegates in it. */
export type CventOnlyForDelegates = {
    appointment: CventExistingAppointment;
    /** The known delegates in it, by Salesforce id. */
    delegateIds: string[];
    /** True when a sponsor rep is in it, so it is an S2D meeting. */
    hasSponsor: boolean;
};

/**
 * Lists the Cvent appointments this database has no meeting for, with the delegates in each.
 * Appointments with no known delegate are left out.
 *
 * @param {CventExistingAppointment[]} appointments - The event's active Cvent appointments.
 * @param {Attendee[]} attendees - The event's attendees.
 * @param {Set<string>} knownAppointmentIds - Every Cvent appointment id stored in this database, roundtables included.
 * @returns {CventOnlyForDelegates[]} The appointments only in Cvent that have delegates.
 */
export function cventOnlyForDelegates(
    appointments: CventExistingAppointment[],
    attendees: Attendee[],
    knownAppointmentIds: Set<string>,
): CventOnlyForDelegates[] {
    const byContact = new Map(attendees.filter((a) => a.cventContactId).map((a) => [a.cventContactId, a]));
    const out: CventOnlyForDelegates[] = [];
    for (const appointment of appointmentsNotInPortal(appointments, knownAppointmentIds)) {
        const people = appointment.participantContactIds
            .map((id) => byContact.get(id))
            .filter((a): a is Attendee => !!a);
        const delegateIds = [...new Set(people.filter((a) => a.role === "delegate").map((a) => a.salesforceId))];
        if (delegateIds.length === 0) continue;
        out.push({ appointment, delegateIds, hasSponsor: people.some((a) => a.role === "sponsor") });
    }
    return out;
}

/**
 * Counts each delegate's S2D and D2D meetings, in the portal and only in Cvent.
 *
 * @param {MeetingRef[]} rows - The event's scheduled_meetings rows.
 * @param {CventOnlyForDelegates[]} cventOnly - From cventOnlyForDelegates.
 * @returns {Map<string, DelegateCounts>} The counts by Salesforce id. Delegates with none are left out.
 */
export function delegateMeetingCounts(
    rows: MeetingRef[],
    cventOnly: CventOnlyForDelegates[],
): Map<string, DelegateCounts> {
    const out = new Map<string, DelegateCounts>();
    /**
     * Adds one meeting of a kind to a delegate's counts.
     *
     * @param {string} id - The delegate's Salesforce id.
     * @param {keyof DelegateCounts} kind - Which count to add to.
     */
    const add = (id: string, kind: keyof DelegateCounts): void => {
        const c = out.get(id) ?? { s2d: 0, d2d: 0 };
        c[kind]++;
        out.set(id, c);
    };
    for (const r of rows) {
        if (r.kind === "delegate_delegate") {
            add(r.attendeeA, "d2d");
            add(r.attendeeB, "d2d");
        } else {
            // On an S2D meeting attendeeA is the sponsor company, so only attendeeB is a delegate.
            add(r.attendeeB, "s2d");
        }
    }
    for (const c of cventOnly) {
        for (const id of c.delegateIds) add(id, c.hasSponsor ? "s2d" : "d2d");
    }
    return out;
}

/**
 * The start times each party is already booked at, as epoch ms.
 * Every given row counts for both its parties, and every Cvent appointment for each delegate in it.
 *
 * @param {MeetingRef[]} rows - The meetings to count as busy.
 * @param {Map<string, Pick<Timeslot, "startTime">>} timeslotById - The event's timeslots.
 * @param {CventExistingAppointment[]} appointments - The event's active Cvent appointments.
 * @param {Attendee[]} attendees - The event's attendees, to map Cvent contacts to delegates.
 * @returns {Map<string, Set<number>>} Busy start times by party id.
 */
export function busyStartTimes(
    rows: MeetingRef[],
    timeslotById: Map<string, Pick<Timeslot, "startTime">>,
    appointments: CventExistingAppointment[],
    attendees: Attendee[],
): Map<string, Set<number>> {
    const out = new Map<string, Set<number>>();
    /**
     * Marks a party busy at a time.
     *
     * @param {string} id - The party id.
     * @param {number} ms - The start time, as epoch ms.
     */
    const add = (id: string, ms: number): void => {
        if (Number.isNaN(ms)) return;
        const set = out.get(id) ?? new Set<number>();
        set.add(ms);
        out.set(id, set);
    };
    for (const r of rows) {
        const start = timeslotById.get(r.timeslotId)?.startTime;
        if (!start) continue;
        add(r.attendeeA, startMs(start));
        add(r.attendeeB, startMs(start));
    }
    const delegateByContact = new Map(
        attendees.filter((a) => a.role === "delegate" && a.cventContactId).map((a) => [a.cventContactId, a.salesforceId]),
    );
    for (const appt of appointments) {
        for (const contactId of appt.participantContactIds) {
            const id = delegateByContact.get(contactId);
            if (id) add(id, startMs(appt.startTime));
        }
    }
    return out;
}

/** The parts of a roundtable seat these helpers read. */
export type SeatRef = { roundtableId: string; delegateId: string; role: "seated" | "alternate" };

/** The parts of a roundtable these helpers read. */
export type RoundtableRef = { id: string; timeslotId: string };

/**
 * The delegates seated at a roundtable, pushed or not.
 * Alternates aren't seated, so they are left out.
 *
 * @param {SeatRef[]} seats - The event's roundtable seats.
 * @returns {Set<string>} The seated delegates' Salesforce ids.
 */
export function seatedDelegateIds(seats: SeatRef[]): Set<string> {
    return new Set(seats.filter((s) => s.role === "seated").map((s) => s.delegateId));
}

/**
 * The start times seated roundtable delegates are busy at, as epoch ms.
 * A roundtable is a meeting at its table's time, so each seated delegate is busy then.
 * Alternates aren't seated, so they stay free.
 *
 * @param {SeatRef[]} seats - The event's roundtable seats.
 * @param {RoundtableRef[]} tables - The event's roundtables.
 * @param {Map<string, Pick<Timeslot, "startTime">>} timeslotById - The event's timeslots.
 * @returns {Map<string, Set<number>>} Busy start times by Salesforce id.
 */
export function seatedBusyTimes(
    seats: SeatRef[],
    tables: RoundtableRef[],
    timeslotById: Map<string, Pick<Timeslot, "startTime">>,
): Map<string, Set<number>> {
    const slotByTable = new Map(tables.map((t) => [t.id, t.timeslotId]));
    const out = new Map<string, Set<number>>();
    for (const s of seats) {
        if (s.role !== "seated") continue;
        const start = timeslotById.get(slotByTable.get(s.roundtableId) ?? "")?.startTime;
        if (!start) continue;
        const set = out.get(s.delegateId) ?? new Set<number>();
        set.add(startMs(start));
        out.set(s.delegateId, set);
    }
    return out;
}

/**
 * Joins busy-time maps, keeping every time from each.
 *
 * @param {Map<string, Set<number>>[]} maps - The busy times to join.
 * @returns {Map<string, Set<number>>} A new map with every party's times.
 */
export function mergeBusyTimes(...maps: Map<string, Set<number>>[]): Map<string, Set<number>> {
    const out = new Map<string, Set<number>>();
    for (const m of maps) {
        for (const [id, times] of m) {
            const set = out.get(id) ?? new Set<number>();
            for (const t of times) set.add(t);
            out.set(id, set);
        }
    }
    return out;
}

/**
 * The event day of a start time, from the timeslots on the same date.
 * A date with no timeslot counts as Day 2, so the Day 1 rule never relies on it.
 *
 * @param {string} startTime - The ISO start time.
 * @param {Timeslot[]} timeslots - The event's timeslots.
 * @returns {number} The day.
 */
export function dayOfStart(startTime: string, timeslots: Timeslot[]): number {
    const ms = startMs(startTime);
    if (Number.isNaN(ms)) return 2;
    const date = new Date(ms).toISOString().slice(0, 10);
    return timeslots.find((t) => t.startTime.slice(0, 10) === date)?.day ?? 2;
}

/**
 * D2D meetings a run keeps, as the engine needs them.
 * Pushed portal D2D meetings, plus delegate-only appointments only in Cvent.
 * A Cvent appointment counts as one meeting for each delegate in it, as delegateMeetingCounts counts it.
 * So each delegate gets one entry with a stand-in partner, and the others in it are listed so they aren't paired again.
 *
 * @param {(MeetingRef & { day: number })[]} keptRows - The D2D rows the run keeps.
 * @param {CventOnlyForDelegates[]} cventOnly - From cventOnlyForDelegates.
 * @param {Timeslot[]} timeslots - The event's timeslots, for the day of a Cvent appointment.
 * @returns {ExistingD2D[]} The kept meetings.
 */
export function keptD2DMeetings(
    keptRows: (MeetingRef & { day: number })[],
    cventOnly: CventOnlyForDelegates[],
    timeslots: Timeslot[],
): ExistingD2D[] {
    const out: ExistingD2D[] = keptRows.map((r) => ({ attendeeA: r.attendeeA, attendeeB: r.attendeeB, day: r.day }));
    for (const c of cventOnly) {
        if (c.hasSponsor) continue;
        const day = dayOfStart(c.appointment.startTime, timeslots);
        const standIn = `cvent:${c.appointment.id ?? c.appointment.startTime}`;
        for (const id of c.delegateIds) {
            out.push({ attendeeA: id, attendeeB: standIn, day, others: c.delegateIds.filter((o) => o !== id) });
        }
    }
    return out;
}

/**
 * How many more meetings each timeslot can take.
 * Cvent's capacity is the location's setting, so appointments already at that location and time are taken off.
 * When Cvent's appointment list couldn't be read, the given portal meetings in each timeslot are taken off instead.
 *
 * @param {Timeslot[]} timeslots - The slots to work out.
 * @param {Location[]} locations - The event's locations, for matching appointments by name.
 * @param {CventExistingAppointment[] | null} appointments - The event's Cvent appointments, or null when they couldn't be read.
 * @param {MeetingRef[]} keptRows - Portal meetings that stay, used when Cvent couldn't be read.
 * @returns {Map<string, number>} The room left by timeslot id.
 */
export function slotRoomLeft(
    timeslots: Timeslot[],
    locations: Location[],
    appointments: CventExistingAppointment[] | null,
    keptRows: MeetingRef[],
): Map<string, number> {
    const nameById = new Map(locations.map((l) => [l.id, l.name]));
    const booked = new Map<string, number>();
    if (appointments) {
        for (const a of appointments) {
            if (!a.locationName) continue;
            const key = slotRoomKey(a.locationName, a.startTime);
            booked.set(key, (booked.get(key) ?? 0) + 1);
        }
    }
    const byTimeslot = new Map<string, number>();
    for (const r of keptRows) byTimeslot.set(r.timeslotId, (byTimeslot.get(r.timeslotId) ?? 0) + 1);
    return new Map(
        timeslots.map((t) => {
            if (!appointments) return [t.id, t.capacity - (byTimeslot.get(t.id) ?? 0)];
            const name = t.locationId ? nameById.get(t.locationId) : undefined;
            return [t.id, t.capacity - (name ? (booked.get(slotRoomKey(name, t.startTime)) ?? 0) : 0)];
        }),
    );
}
