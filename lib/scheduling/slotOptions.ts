import type { Location, Timeslot } from "@/types";
import type { MeetingKind } from "@/lib/events/meetingKinds";

// ---------------------------------------------------------------------------
// Slot options for the admin Edit and Create Meeting windows.
//
// Pure helpers, moved out of app/admin/meetings/[sponsorId]/actions.ts so they can be unit tested.
// Admins can pick any slot on either day, of any appointment type.
// Options are grouped by appointment type, with sponsor_delegate types first.
// A slot of another kind shows a warning before saving.
// ---------------------------------------------------------------------------

/** One option in the timeslot picker inside the edit/create meeting modals. */
export type SlotOption = {
    timeslotId: string;
    day: 1 | 2;
    startTime: string;
    endTime: string;
    /** The timeslot's native Cvent location, used as the default when booking. */
    locationId: string | null;
    locationName: string | null;
    /** The slot's Cvent appointment-type id. Null when the slot is no longer listed in Cvent. */
    appointmentTypeId: string | null;
    /** Cvent's name for the slot's appointment type. Null when it isn't known. */
    appointmentTypeName: string | null;
    /** The meeting kind the event maps the slot's type to. Null when the slot is no longer listed in Cvent. */
    kind: MeetingKind | null;
};

/** A booked time span (epoch ms) an attendee is already committed to. */
export type BookedInterval = { start: number; end: number };

/**
 * Builds the list of time intervals an attendee is already booked into, from a
 * list of meetings (the meeting being edited having been excluded upstream).
 * Meetings whose timeslot can't be resolved are skipped.
 *
 * @param {{ attendeeA: string; attendeeB: string; timeslotId: string }[]} meetings - Meetings to scan.
 * @param {string} attendeeId - The attendee (party id) to collect bookings for.
 * @param {Map<string, Timeslot>} timeslotById - Timeslot lookup for resolving times.
 * @returns {BookedInterval[]} The attendee's booked time spans.
 */
export function bookedIntervals(
    meetings: { attendeeA: string; attendeeB: string; timeslotId: string }[],
    attendeeId: string,
    timeslotById: Map<string, Timeslot>,
): BookedInterval[] {
    const intervals: BookedInterval[] = [];
    for (const m of meetings) {
        if (m.attendeeA !== attendeeId && m.attendeeB !== attendeeId) continue;
        const ts = timeslotById.get(m.timeslotId);
        if (!ts) continue;
        intervals.push({
            start: new Date(ts.startTime).getTime(),
            end: new Date(ts.endTime).getTime(),
        });
    }
    return intervals;
}

/**
 * Whether a timeslot's time span overlaps any of the given booked intervals.
 * Two spans overlap when each starts before the other ends.
 *
 * @param {Timeslot} t - The candidate timeslot.
 * @param {BookedInterval[]} intervals - Already-booked spans to test against.
 * @returns {boolean} True when the timeslot collides with a booked span.
 */
export function overlapsBooked(t: Timeslot, intervals: BookedInterval[]): boolean {
    const start = new Date(t.startTime).getTime();
    const end = new Date(t.endTime).getTime();
    return intervals.some((i) => start < i.end && i.start < end);
}

/**
 * Turns one timeslot into a picker option, resolving its location name.
 *
 * @param {Timeslot} t - The timeslot.
 * @param {Map<string, Location>} locationById - Location lookup for the name.
 * @returns {SlotOption} The option.
 */
export function slotOptionFromTimeslot(
    t: Timeslot,
    locationById: Map<string, Location>,
): SlotOption {
    return {
        timeslotId: t.id,
        day: t.day,
        startTime: t.startTime,
        endTime: t.endTime,
        locationId: t.locationId,
        locationName: t.locationId
            ? (locationById.get(t.locationId)?.name ?? null)
            : null,
        appointmentTypeId: t.appointmentTypeId,
        appointmentTypeName: t.appointmentTypeName,
        kind: t.kind,
    };
}

/**
 * Where an option's group sorts.
 * Sponsor_delegate types come first, then other known types, then slots with no known type.
 *
 * @param {SlotOption} o - The option.
 * @returns {number} 0, 1 or 2.
 */
function groupRank(o: SlotOption): number {
    if (o.kind === "sponsor_delegate") return 0;
    if (o.kind !== null) return 1;
    return 2;
}

/**
 * The label shown for an option's appointment type.
 * Falls back to the type id, then to a generic label.
 *
 * @param {SlotOption} o - The option.
 * @returns {string} The label.
 */
export function slotTypeLabel(o: SlotOption): string {
    return o.appointmentTypeName ?? o.appointmentTypeId ?? "Unknown appointment type";
}

/**
 * Sorts slot options into appointment-type groups.
 * Sponsor_delegate types come first, then the other types by name.
 * Within a type, options are sorted by day then start time.
 *
 * @param {SlotOption[]} options - The options to sort.
 * @returns {SlotOption[]} A new, sorted array.
 */
export function sortSlotOptions(options: SlotOption[]): SlotOption[] {
    return [...options].sort(
        (a, b) =>
            groupRank(a) - groupRank(b) ||
            slotTypeLabel(a).localeCompare(slotTypeLabel(b)) ||
            (a.appointmentTypeId ?? "").localeCompare(b.appointmentTypeId ?? "") ||
            a.day - b.day ||
            a.startTime.localeCompare(b.startTime),
    );
}

/**
 * Builds the list of timeslot options available to BOTH attendees: timeslots
 * whose time overlaps no existing booking for either attendee. (Capacity is
 * enforced by the engine; the admin picker keeps it simple by treating a time
 * as taken once either attendee holds any meeting then.) Grouped by appointment
 * type with sponsor_delegate types first, then sorted by day and start time
 * within each type. Every slot on both days is offered, whatever its type.
 *
 * @param {Timeslot[]} timeslots - The event's timeslots.
 * @param {Map<string, Location>} locationById - Location lookup for option names.
 * @param {BookedInterval[]} bookedA - The first attendee's bookings.
 * @param {BookedInterval[]} bookedB - The second attendee's bookings.
 * @returns {SlotOption[]} The sorted options.
 */
export function buildSlotOptions(
    timeslots: Timeslot[],
    locationById: Map<string, Location>,
    bookedA: BookedInterval[],
    bookedB: BookedInterval[],
): SlotOption[] {
    return sortSlotOptions(
        timeslots
            .filter(
                (t) =>
                    (t.day === 1 || t.day === 2) &&
                    !overlapsBooked(t, bookedA) &&
                    !overlapsBooked(t, bookedB),
            )
            .map((t) => slotOptionFromTimeslot(t, locationById)),
    );
}

/** One appointment-type group of options, for an <optgroup>. */
export type SlotOptionGroup = {
    /** The group's heading, the appointment type's name. */
    label: string;
    kind: MeetingKind | null;
    options: SlotOption[];
};

/**
 * Splits sorted options into consecutive appointment-type groups, keeping their order.
 *
 * @param {SlotOption[]} options - Options already sorted by sortSlotOptions.
 * @returns {SlotOptionGroup[]} The groups, in order.
 */
export function groupSlotOptions(options: SlotOption[]): SlotOptionGroup[] {
    const groups: SlotOptionGroup[] = [];
    let lastKey: string | null = null;
    for (const o of options) {
        const key = o.appointmentTypeId ?? "";
        if (groups.length === 0 || key !== lastKey) {
            groups.push({ label: slotTypeLabel(o), kind: o.kind, options: [] });
            lastKey = key;
        }
        groups[groups.length - 1].options.push(o);
    }
    return groups;
}

/**
 * The warning shown when an admin picks a slot that isn't a sponsor slot.
 * The meeting will be pushed to Cvent under that slot's appointment type.
 * A sponsor_delegate slot, or a slot whose type isn't known, gets no warning.
 *
 * @param {SlotOption | null | undefined} o - The chosen option.
 * @returns {string | null} The warning, or null.
 */
export function slotTypeWarning(o: SlotOption | null | undefined): string | null {
    if (!o || o.kind === null || o.kind === "sponsor_delegate") return null;
    return `This meeting will appear in Cvent as a "${slotTypeLabel(o)}" appointment, not a sponsor to delegate meeting.`;
}
