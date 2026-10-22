// ---------------------------------------------------------------------------
// Meeting kinds and the per-event appointment-type mapping
//
// Each event maps its Cvent appointment types to a meeting kind in Event settings.
// The scheduler, the admin meeting editor and push read the kind to decide which slots a meeting may use.
// The kind of a meeting comes from who is meeting, never from an admin.
//
// This module is pure, with no server-only imports.
// The Event settings form, server actions and the engine all share it.
// ---------------------------------------------------------------------------

/**
 * The meeting kinds an appointment type can be mapped to, in display order.
 * - sponsor_delegate: a sponsor company meeting a delegate.
 * - delegate_delegate: two delegates meeting each other.
 * - delegate_group: delegates plus one staff member. Nothing uses it yet.
 * - ignore: slots the portal never uses. Unmapped types behave the same way.
 */
export const MEETING_KINDS = [
    "sponsor_delegate",
    "delegate_delegate",
    "delegate_group",
    "ignore",
] as const;

/** One meeting kind. See MEETING_KINDS. */
export type MeetingKind = (typeof MEETING_KINDS)[number];

/** Friendly labels for the meeting kinds, for dropdowns and messages. */
export const MEETING_KIND_LABEL: Record<MeetingKind, string> = {
    sponsor_delegate: "Sponsor to delegate",
    delegate_delegate: "Delegate to delegate",
    delegate_group: "Delegate group",
    ignore: "Ignore",
};

/**
 * An event's mapping from Cvent appointment-type id to meeting kind.
 * Stored as jsonb in event_settings.appointment_type_kinds.
 * A type with no entry is unmapped and behaves as `ignore`.
 */
export type AppointmentTypeKinds = Record<string, MeetingKind>;

/** A Cvent appointment type, reduced to what the portal needs. */
export type AppointmentType = {
    /** Cvent appointment-type id. */
    id: string;
    /** Display name from Cvent (e.g. "Sponsor to Delegate Meetings"). */
    name: string;
};

/**
 * Whether a value is one of the four allowed meeting kinds.
 *
 * @param {unknown} value - The value to check.
 * @returns {boolean} True when the value is a MeetingKind.
 */
export function isMeetingKind(value: unknown): value is MeetingKind {
    return (
        typeof value === "string" &&
        (MEETING_KINDS as readonly string[]).includes(value)
    );
}

/**
 * Looks up the meeting kind for one appointment type.
 * Unmapped types, and events with no mapping at all, get `ignore`.
 *
 * @param {AppointmentTypeKinds | null | undefined} kinds - The event's mapping.
 * @param {string} appointmentTypeId - The Cvent appointment-type id.
 * @returns {MeetingKind} The mapped kind, or `ignore`.
 */
export function kindForAppointmentType(
    kinds: AppointmentTypeKinds | null | undefined,
    appointmentTypeId: string,
): MeetingKind {
    const kind = kinds?.[appointmentTypeId];
    return isMeetingKind(kind) ? kind : "ignore";
}

/**
 * Validates a submitted appointment-type mapping before it is saved.
 * The value must be an object whose keys are type ids and whose values are allowed kinds.
 * An empty mapping is stored as null.
 *
 * @param {unknown} value - The submitted mapping.
 * @returns {{ ok: true; kinds: AppointmentTypeKinds | null } | { ok: false; error: string }} The clean mapping, or an error message.
 */
export function parseAppointmentTypeKinds(
    value: unknown,
):
    | { ok: true; kinds: AppointmentTypeKinds | null }
    | { ok: false; error: string } {
    if (value === null || value === undefined) return { ok: true, kinds: null };
    if (typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, error: "Error: appointment type mapping is invalid" };
    }

    const kinds: AppointmentTypeKinds = {};
    for (const [typeId, kind] of Object.entries(value)) {
        if (!typeId.trim()) {
            return { ok: false, error: "Error: appointment type id is missing" };
        }
        if (!isMeetingKind(kind)) {
            return {
                ok: false,
                error: `Error: "${String(kind)}" is not a valid meeting kind`,
            };
        }
        kinds[typeId] = kind;
    }
    return { ok: true, kinds: Object.keys(kinds).length > 0 ? kinds : null };
}

/** One appointment type row in the Event settings mapping section. */
export type AppointmentTypeRow = {
    id: string;
    name: string;
    /** The saved kind, or "" when the type is not mapped yet. */
    kind: MeetingKind | "";
    /** Every kind the admin can choose for this type. */
    options: readonly MeetingKind[];
};

/**
 * Builds the rows for the Event settings mapping section.
 * Every appointment type Cvent returns gets a row, and every row offers all four kinds.
 *
 * @param {AppointmentType[]} types - The event's appointment types from Cvent.
 * @param {Record<string, string> | null | undefined} kinds - The saved or edited mapping. Values that aren't kinds show as blank.
 * @returns {AppointmentTypeRow[]} One row per appointment type, in Cvent's order.
 */
export function appointmentTypeRows(
    types: AppointmentType[],
    kinds: Record<string, string> | null | undefined,
): AppointmentTypeRow[] {
    return types.map((t) => {
        const saved = kinds?.[t.id];
        return {
            id: t.id,
            name: t.name,
            kind: isMeetingKind(saved) ? saved : "",
            options: MEETING_KINDS,
        };
    });
}

/** The scheduler's pre-run check on an event's appointment-type mapping. */
export type MappingCheck =
    | { ok: true; unmappedTypeNames: string[] }
    | { ok: false; message: string };

/** Shown when a scheduler run stops because no type is mapped to sponsor_delegate. */
export const NO_SPONSOR_MAPPING_MESSAGE =
    "No Cvent appointment type is mapped to sponsor to delegate meetings for this event. " +
    "Set the mapping in Event settings, then run the scheduler again. No meetings were changed.";

/**
 * Checks an event's mapping before a scheduler run.
 * The run must stop when no type is mapped to `sponsor_delegate`.
 * Otherwise it would delete every un-pushed meeting and create none.
 * When it can go ahead, it lists the names of types with no mapping, so the run report can warn about them.
 * A type the admin set to `ignore` counts as mapped.
 *
 * @param {AppointmentType[]} types - The event's appointment types from Cvent.
 * @param {AppointmentTypeKinds | null | undefined} kinds - The saved mapping.
 * @param {string[]} [slotTypeIds=[]] - Appointment-type ids seen on the event's timeslots.
 *   A type with slots that Cvent didn't list is still warned about, by id.
 * @returns {MappingCheck} Whether the run may go ahead, and which types are unmapped.
 */
export function checkAppointmentTypeMapping(
    types: AppointmentType[],
    kinds: AppointmentTypeKinds | null | undefined,
    slotTypeIds: string[] = [],
): MappingCheck {
    const mapped = kinds ?? {};
    if (!Object.values(mapped).includes("sponsor_delegate")) {
        return { ok: false, message: NO_SPONSOR_MAPPING_MESSAGE };
    }

    // Types Cvent lists come first, by name.
    // Slot types Cvent didn't list follow, by id.
    const names: string[] = [];
    const seen = new Set<string>();
    for (const t of types) {
        seen.add(t.id);
        if (!isMeetingKind(mapped[t.id])) names.push(t.name);
    }
    for (const id of slotTypeIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (!isMeetingKind(mapped[id])) names.push(id);
    }
    return { ok: true, unmappedTypeNames: names };
}
