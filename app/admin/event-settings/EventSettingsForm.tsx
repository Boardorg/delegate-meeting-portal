"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { EventSettingsRow } from "@/lib/db/schema";
import {
    MEETING_KIND_LABEL,
    appointmentTypeRows,
    type AppointmentType,
    type MeetingKind,
} from "@/lib/events/meetingKinds";
import { createEvent, updateEvent, deleteEvent } from "./actions";

// ---------------------------------------------------------------------------
// EventSettingsForm — edit the active event's Cvent config, or create a new
// event. The event being edited follows the global sidebar switcher; creating
// an event makes it active (and thus the one shown here).
//
// The Appointment types section maps each of the event's Cvent appointment types to a meeting kind.
// It only shows when editing an existing event.
// ---------------------------------------------------------------------------

/** The active event's Cvent appointment types, or why they couldn't be loaded. */
export type AppointmentTypesLoad =
    | { ok: true; types: AppointmentType[] }
    | { ok: false; reason: string };

type Props = {
    active: EventSettingsRow | null;
    hasEvents: boolean;
    /** Null when there is no active event. */
    appointmentTypes: AppointmentTypesLoad | null;
};

/** The mapping being edited. A blank kind means the type is not mapped. */
type KindsDraft = Record<string, MeetingKind | "">;

/**
 * Builds the mapping draft from the saved row, for controlled dropdowns.
 *
 * @param {EventSettingsRow | null} row - The active event's settings row.
 * @returns {KindsDraft} The saved kinds, keyed by appointment-type id.
 */
function kindsFrom(row: EventSettingsRow | null): KindsDraft {
    return { ...(row?.appointmentTypeKinds ?? {}) };
}

/**
 * Turns the draft into the mapping to save.
 * Only types Cvent listed are kept, and unmapped types are left out.
 *
 * @param {KindsDraft} draft - The edited mapping.
 * @param {AppointmentType[]} types - The event's appointment types.
 * @returns {Record<string, string>} The mapping to send to the server.
 */
function kindsToSave(
    draft: KindsDraft,
    types: AppointmentType[],
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of types) {
        const kind = draft[t.id];
        if (kind) out[t.id] = kind;
    }
    return out;
}

/** The editable settings fields (code is handled separately). */
type Draft = {
    name: string;
    themeColor: string;
    logoUrl: string;
    cventEventId: string;
    cventAppointmentEventId: string;
};

/** Builds a draft from a row (nulls → empty strings for controlled inputs). */
function draftFrom(row: EventSettingsRow | null): Draft {
    return {
        name: row?.name ?? "",
        themeColor: row?.themeColor ?? "",
        logoUrl: row?.logoUrl ?? "",
        cventEventId: row?.cventEventId ?? "",
        cventAppointmentEventId: row?.cventAppointmentEventId ?? "",
    };
}

// The default frontend brand color (globals.css --accent). Shown as the swatch's
// value when no per-event color is set, so the picker opens on the real
// fallback rather than an arbitrary default.
const FALLBACK_COLOR = "#089e9d";

// The Cvent id fields, in display order. Kept as data so the inputs render
// from one list instead of near-identical blocks. The appointment host is not
// configured here — each pushed meeting is hosted by its requester.
const ID_FIELDS: { key: keyof Draft; label: string; hint: string }[] = [
    {
        key: "cventEventId",
        label: "Cvent Event ID",
        hint: "The Cvent event uuid.",
    },
    {
        key: "cventAppointmentEventId",
        label: "Cvent Appointment Event ID",
        hint: "find in the cvent appointments area",
    },
];

export default function EventSettingsForm({
    active,
    hasEvents,
    appointmentTypes,
}: Props) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();

    // Create mode is forced when there are no events; otherwise we edit `active`.
    const [creating, setCreating] = useState(!hasEvents);
    const [code, setCode] = useState("");
    const [draft, setDraft] = useState<Draft>(draftFrom(active));
    const [kinds, setKinds] = useState<KindsDraft>(kindsFrom(active));
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [message, setMessage] = useState<{
        ok: boolean;
        text: string;
    } | null>(null);

    // Note: this component is keyed on the active event code by the page, so it
    // remounts (resetting the state above from props) whenever the active event
    // changes via the sidebar switcher or a create/delete refresh — no effect
    // needed to re-sync.

    function set<K extends keyof Draft>(key: K, value: string) {
        setDraft((d) => ({ ...d, [key]: value }));
    }

    function beginCreate() {
        setCreating(true);
        setCode("");
        setDraft(draftFrom(null));
        setConfirmDelete(false);
        setMessage(null);
    }

    function cancelCreate() {
        setCreating(false);
        setDraft(draftFrom(active));
        setMessage(null);
    }

    function handleSave() {
        // Only send the mapping when the types loaded.
        // Otherwise the save leaves the stored mapping as it is.
        const mapping =
            appointmentTypes?.ok
                ? { appointmentTypeKinds: kindsToSave(kinds, appointmentTypes.types) }
                : {};
        startTransition(async () => {
            const res = creating
                ? await createEvent({ code, ...draft })
                : active
                  ? await updateEvent(active.code, { ...draft, ...mapping })
                  : ({ ok: false, error: "Error: no event selected" } as const);

            if (res.ok) {
                setCreating(false);
                setMessage({ ok: true, text: `Saved “${res.event.code}”.` });
                router.refresh();
            } else {
                setMessage({ ok: false, text: res.error });
            }
        });
    }

    function handleDelete() {
        if (!active) return;
        startTransition(async () => {
            const res = await deleteEvent(active.code);
            if (res.ok) {
                setConfirmDelete(false);
                setMessage({ ok: true, text: `Deleted “${active.code}”.` });
                router.refresh();
            } else {
                setMessage({ ok: false, text: res.error });
            }
        });
    }

    const title = creating
        ? "New event"
        : active
          ? active.name
              ? `${active.name} (${active.code})`
              : active.code
          : "Event settings";

    return (
        <div className="adm-page">
            <div className="adm-page-head">
                <h1 className="adm-page-title">Event settings</h1>
                {!creating && (
                    <button
                        type="button"
                        className="adm-new-btn adm-new-btn-primary"
                        onClick={beginCreate}
                        disabled={pending}
                    >
                        + New event
                    </button>
                )}
            </div>

            {!creating && !active ? (
                <div className="adm-empty adm-empty-lg">
                    No events yet. Click “+ New event” to add one.
                </div>
            ) : (
                <div className="adm-card adm-form-card">
                    <div className="adm-card-title">{title}</div>

                    {/* Event code — editable only when creating. */}
                    <label className="adm-field adm-field-mb">
                        <span className="adm-field-label">Event Code</span>
                        {creating ? (
                            <input
                                type="text"
                                className="adm-input"
                                placeholder="e.g. BMWS"
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                disabled={pending}
                            />
                        ) : (
                            <input
                                type="text"
                                className="adm-input"
                                value={active?.code ?? ""}
                                disabled
                            />
                        )}
                    </label>

                    <label className="adm-field adm-field-mb">
                        <span className="adm-field-label">Name</span>
                        <input
                            type="text"
                            className="adm-input"
                            placeholder="Friendly event name (optional)"
                            value={draft.name}
                            onChange={(e) => set("name", e.target.value)}
                            disabled={pending}
                        />
                    </label>

                    {/* Event color — drives the frontend's primary accent
                        (buttons, request highlights). Empty falls back to the
                        default teal. The native swatch and the hex text input
                        stay in sync; the swatch always shows a concrete color,
                        so it opens on the fallback when nothing is set. */}
                    <label className="adm-field adm-field-mb">
                        <span className="adm-field-label">Event Color</span>
                        <div className="adm-color-row">
                            <input
                                type="color"
                                className="adm-color-swatch"
                                aria-label="Event color picker"
                                value={draft.themeColor || FALLBACK_COLOR}
                                onChange={(e) =>
                                    set("themeColor", e.target.value)
                                }
                                disabled={pending}
                            />
                            <input
                                type="text"
                                className="adm-input"
                                placeholder={`${FALLBACK_COLOR} (default)`}
                                value={draft.themeColor}
                                onChange={(e) =>
                                    set("themeColor", e.target.value)
                                }
                                disabled={pending}
                            />
                        </div>
                        <span className="adm-field-hint">
                            Primary accent color for this event’s frontend.
                            Leave blank to use the default teal.
                        </span>
                    </label>

                    {/* Logo URL — shown in the header next to the Assemble mark
                        (frontend + admin). Absolute (https://…) or root-relative
                        (/…); blank hides it. */}
                    <label className="adm-field adm-field-mb">
                        <span className="adm-field-label">Logo URL</span>
                        <input
                            type="text"
                            className="adm-input"
                            placeholder="https://… or /path.png (optional)"
                            value={draft.logoUrl}
                            onChange={(e) => set("logoUrl", e.target.value)}
                            disabled={pending}
                        />
                        <span className="adm-field-hint">
                            Event logo shown in the header. Leave blank for none.
                        </span>
                    </label>

                    {ID_FIELDS.map((f) => (
                        <label key={f.key} className="adm-field adm-field-mb">
                            <span className="adm-field-label">{f.label}</span>
                            <input
                                type="text"
                                className="adm-input"
                                value={draft[f.key]}
                                onChange={(e) => set(f.key, e.target.value)}
                                disabled={pending}
                            />
                            <span className="adm-field-hint">{f.hint}</span>
                        </label>
                    ))}

                    {/* Appointment types. Each Cvent type maps to a meeting kind.
                        Only shown when editing an existing event. */}
                    {!creating && appointmentTypes && (
                        <div className="adm-field adm-field-mb">
                            <span className="adm-field-label">
                                Appointment Types
                            </span>
                            <span className="adm-field-hint adm-field-mb">
                                Map each Cvent appointment type to a meeting
                                kind. The scheduler only books sponsor meetings
                                into types mapped to “Sponsor to delegate”. That
                                is the only mapping needed for now. Unmapped
                                types are ignored.
                            </span>
                            {!appointmentTypes.ok ? (
                                <div className="adm-modal-warn-at">
                                    {appointmentTypes.reason}
                                </div>
                            ) : appointmentTypes.types.length === 0 ? (
                                <div className="adm-modal-warn-at">
                                    Cvent returned no appointment types for this
                                    event.
                                </div>
                            ) : (
                                appointmentTypeRows(
                                    appointmentTypes.types,
                                    kinds,
                                ).map((row) => (
                                    <label
                                        key={row.id}
                                        className="adm-field adm-field-mb"
                                    >
                                        <span className="adm-field-label">
                                            {row.name}
                                        </span>
                                        <select
                                            className="adm-input adm-select"
                                            value={row.kind}
                                            onChange={(e) =>
                                                setKinds((k) => ({
                                                    ...k,
                                                    [row.id]: e.target.value as
                                                        | MeetingKind
                                                        | "",
                                                }))
                                            }
                                            disabled={pending}
                                        >
                                            <option value="">Not mapped</option>
                                            {row.options.map((kind) => (
                                                <option key={kind} value={kind}>
                                                    {MEETING_KIND_LABEL[kind]}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                ))
                            )}
                        </div>
                    )}

                    {message && (
                        <div
                            className={
                                message.ok ? "adm-form-ok" : "adm-modal-error"
                            }
                        >
                            {message.text}
                        </div>
                    )}

                    <div className="adm-modal-actions">
                        {creating ? (
                            <>
                                {hasEvents && (
                                    <button
                                        type="button"
                                        className="adm-btn"
                                        onClick={cancelCreate}
                                        disabled={pending}
                                    >
                                        Cancel
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className="adm-btn adm-btn-primary"
                                    onClick={handleSave}
                                    disabled={pending || !code.trim()}
                                >
                                    {pending ? "Creating…" : "Create event"}
                                </button>
                            </>
                        ) : confirmDelete ? (
                            <>
                                <span className="adm-confirm-label">
                                    Delete this event?
                                </span>
                                <button
                                    type="button"
                                    className="adm-btn adm-btn-danger"
                                    onClick={handleDelete}
                                    disabled={pending}
                                >
                                    Yes, delete
                                </button>
                                <button
                                    type="button"
                                    className="adm-btn"
                                    onClick={() => setConfirmDelete(false)}
                                    disabled={pending}
                                >
                                    Cancel
                                </button>
                            </>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    className="adm-btn adm-btn-danger adm-mr-auto"
                                    onClick={() => setConfirmDelete(true)}
                                    disabled={pending}
                                >
                                    Delete
                                </button>
                                <button
                                    type="button"
                                    className="adm-btn adm-btn-primary"
                                    onClick={handleSave}
                                    disabled={pending}
                                >
                                    {pending ? "Saving…" : "Save"}
                                </button>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
