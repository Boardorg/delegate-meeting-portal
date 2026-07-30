"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { EventSettingsRow } from "@/lib/db/schema";
import { createEvent, updateEvent, deleteEvent } from "./actions";

// ---------------------------------------------------------------------------
// EventSettingsForm — edit the active event's Cvent config, or create a new
// event. The event being edited follows the global sidebar switcher; creating
// an event makes it active (and thus the one shown here).
// ---------------------------------------------------------------------------

type Props = {
    active: EventSettingsRow | null;
    hasEvents: boolean;
};

/** The editable settings fields (code is handled separately). */
type Draft = {
    name: string;
    cventEventId: string;
    cventAppointmentEventId: string;
};

/** Builds a draft from a row (nulls → empty strings for controlled inputs). */
function draftFrom(row: EventSettingsRow | null): Draft {
    return {
        name: row?.name ?? "",
        cventEventId: row?.cventEventId ?? "",
        cventAppointmentEventId: row?.cventAppointmentEventId ?? "",
    };
}

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

export default function EventSettingsForm({ active, hasEvents }: Props) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();

    // Create mode is forced when there are no events; otherwise we edit `active`.
    const [creating, setCreating] = useState(!hasEvents);
    const [code, setCode] = useState("");
    const [draft, setDraft] = useState<Draft>(draftFrom(active));
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
        startTransition(async () => {
            const res = creating
                ? await createEvent({ code, ...draft })
                : active
                  ? await updateEvent(active.code, draft)
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
