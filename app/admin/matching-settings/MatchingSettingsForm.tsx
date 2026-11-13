"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fmtTime, fmtWeekday } from "@/lib/format";
import { QUESTION_BY_ID } from "@/lib/matching/questions";
import {
    DEFAULT_MATCHING_SETTINGS,
    type MatchingSettings,
    type QuestionSetting,
} from "@/lib/matching/settings";
import { saveMatchingSettings } from "./actions";

// ---------------------------------------------------------------------------
// MatchingSettingsForm — the form on /admin/matching-settings.
//
// Each question list can be reordered by dragging or with the arrow buttons.
// Higher questions count for more, and a turned-off question doesn't count at all.
// ---------------------------------------------------------------------------

/** A roundtable found in Cvent: one delegate_group slot at its location. */
export type CventRoundtable = { timeslotId: string; location: string; startTime: string };

type Props = {
    eventCode: string;
    initial: MatchingSettings;
    roundtables: CventRoundtable[];
    /** How many delegate_delegate slots Cvent has. */
    d2dSlots: number;
    timezone: string;
};

/**
 * Renders the matching settings form for one event.
 *
 * @param {Props} props - The event, its settings, its roundtables in Cvent and the timezone.
 * @returns {JSX.Element} The page body.
 */
export default function MatchingSettingsForm({ eventCode, initial, roundtables, d2dSlots, timezone }: Props) {
    const router = useRouter();
    const [draft, setDraft] = useState<MatchingSettings>(initial);
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
    const [pending, startTransition] = useTransition();

    /**
     * Changes one number in the D2D settings.
     *
     * @param {"capWithoutS2D" | "capWithS2D" | "minScore"} key - The setting.
     * @param {string} value - The typed value.
     */
    function setD2D(key: "capWithoutS2D" | "capWithS2D" | "minScore", value: string) {
        setDraft((d) => ({ ...d, d2d: { ...d.d2d, [key]: Number(value) } }));
    }

    /**
     * Changes one number in the roundtable settings.
     *
     * @param {"seatsPerTable" | "alternatesPerTable" | "minScore"} key - The setting.
     * @param {string} value - The typed value.
     */
    function setRoundtable(key: "seatsPerTable" | "alternatesPerTable" | "minScore", value: string) {
        setDraft((d) => ({ ...d, roundtables: { ...d.roundtables, [key]: Number(value) } }));
    }

    /** Saves the settings. The server checks them and says why when it refuses. */
    function handleSave() {
        startTransition(async () => {
            const result = await saveMatchingSettings(eventCode, draft);
            if (!result.ok) {
                setMessage({ ok: false, text: result.error });
                return;
            }
            setDraft(result.settings);
            setMessage({ ok: true, text: "Saved." });
            router.refresh();
        });
    }

    return (
        <div className="adm-page">
            <div className="adm-page-head">
                <h1 className="adm-page-title">Matching Settings</h1>
            </div>

            <div className="adm-card adm-form-card">
                <div className="adm-card-title">D2D One-on-Ones</div>
                <QuestionList
                    questions={draft.d2d.questions}
                    disabled={pending}
                    onChange={(questions) => setDraft((d) => ({ ...d, d2d: { ...d.d2d, questions } }))}
                />
                <NumberField
                    label="Meetings for a Delegate With No Sponsor Meetings"
                    hint="All of them D2D."
                    value={draft.d2d.capWithoutS2D}
                    onChange={(v) => setD2D("capWithoutS2D", v)}
                    disabled={pending}
                />
                <NumberField
                    label="Meetings in Total for a Delegate With Sponsor Meetings"
                    hint="Sponsor and D2D meetings together."
                    value={draft.d2d.capWithS2D}
                    onChange={(v) => setD2D("capWithS2D", v)}
                    disabled={pending}
                />
                <NumberField
                    label="Minimum Match Score"
                    hint="Out of 100. A pair below it is still booked but marked as a weak match."
                    value={draft.d2d.minScore}
                    onChange={(v) => setD2D("minScore", v)}
                    disabled={pending}
                />
                <span className="adm-field-hint">
                    Cvent has {d2dSlots} Delegate to Delegate {d2dSlots === 1 ? "slot" : "slots"} for this event.
                </span>
            </div>

            <div className="adm-card adm-form-card">
                <div className="adm-card-title">Roundtables</div>
                <QuestionList
                    questions={draft.roundtables.questions}
                    disabled={pending}
                    onChange={(questions) => setDraft((d) => ({ ...d, roundtables: { ...d.roundtables, questions } }))}
                />
                <NumberField
                    label="Seats per Table"
                    value={draft.roundtables.seatsPerTable}
                    onChange={(v) => setRoundtable("seatsPerTable", v)}
                    disabled={pending}
                />
                <NumberField
                    label="Alternates per Table"
                    hint="Listed in the portal only, never sent to Cvent."
                    value={draft.roundtables.alternatesPerTable}
                    onChange={(v) => setRoundtable("alternatesPerTable", v)}
                    disabled={pending}
                />
                <NumberField
                    label="Minimum Match Score"
                    hint="Out of 100. A table whose average is below it is marked as a weak match."
                    value={draft.roundtables.minScore}
                    onChange={(v) => setRoundtable("minScore", v)}
                    disabled={pending}
                />

                <div className="adm-field adm-field-mb">
                    <span className="adm-field-label">Roundtables Found in Cvent ({roundtables.length})</span>
                    <span className="adm-field-hint adm-field-mb">
                        Each Delegate Group slot, at its location, is one table. Check every table the event
                        planned is here.
                    </span>
                    {roundtables.length === 0 ? (
                        <div className="adm-modal-warn-at">
                            No Delegate Group slots were found. Map the roundtable appointment type to Delegate
                            group in Event Settings.
                        </div>
                    ) : (
                        <ul className="adm-sync-list">
                            {roundtables.map((t) => (
                                <li key={t.timeslotId} className="adm-sync-item">
                                    <div className="adm-party-name">{t.location}</div>
                                    <div className="adm-sync-detail">
                                        {fmtWeekday(t.startTime, timezone)} {fmtTime(t.startTime, timezone)}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>

            {message && <div className={message.ok ? "adm-form-ok" : "adm-modal-error"}>{message.text}</div>}

            <div className="adm-modal-actions">
                <button
                    type="button"
                    className="adm-btn adm-mr-auto"
                    disabled={pending}
                    onClick={() => setDraft(DEFAULT_MATCHING_SETTINGS)}
                >
                    Reset to Defaults
                </button>
                <button type="button" className="adm-btn adm-btn-primary" disabled={pending} onClick={handleSave}>
                    {pending ? "Saving…" : "Save"}
                </button>
            </div>
        </div>
    );
}

/**
 * A whole-number setting.
 *
 * @param {{ label: string; hint?: string; value: number; onChange: (value: string) => void; disabled: boolean }} props
 * @returns {JSX.Element} The field.
 */
function NumberField({
    label,
    hint,
    value,
    onChange,
    disabled,
}: {
    label: string;
    hint?: string;
    value: number;
    onChange: (value: string) => void;
    disabled: boolean;
}) {
    return (
        <label className="adm-field adm-field-mb">
            <span className="adm-field-label">{label}</span>
            <input
                type="number"
                className="adm-input"
                min={0}
                step={1}
                value={Number.isFinite(value) ? value : ""}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
            />
            {hint && <span className="adm-field-hint">{hint}</span>}
        </label>
    );
}

/**
 * A question priority list. Questions can be dragged, or moved with the arrows, and turned on or off.
 *
 * @param {{ questions: QuestionSetting[]; disabled: boolean; onChange: (questions: QuestionSetting[]) => void }} props
 * @returns {JSX.Element} The list.
 */
function QuestionList({
    questions,
    disabled,
    onChange,
}: {
    questions: QuestionSetting[];
    disabled: boolean;
    onChange: (questions: QuestionSetting[]) => void;
}) {
    const [dragIndex, setDragIndex] = useState<number | null>(null);

    /**
     * Moves a question from one place to another.
     *
     * @param {number} from - Its current index.
     * @param {number} to - Its new index.
     */
    function moveQuestion(from: number, to: number) {
        if (to < 0 || to >= questions.length || from === to) return;
        const next = [...questions];
        const [item] = next.splice(from, 1);
        next.splice(to, 0, item);
        onChange(next);
    }

    return (
        <div className="adm-field adm-field-mb">
            <span className="adm-field-label">Question Priority</span>
            <span className="adm-field-hint adm-field-mb">
                Higher questions count for more. Turned-off questions aren&apos;t used.
            </span>
            <ol className="adm-sync-list">
                {questions.map((q, i) => (
                    <li
                        key={q.id}
                        className="adm-sync-item"
                        draggable={!disabled}
                        onDragStart={() => setDragIndex(i)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                            if (dragIndex !== null) moveQuestion(dragIndex, i);
                            setDragIndex(null);
                        }}
                        style={{ cursor: disabled ? "default" : "grab", opacity: q.enabled ? 1 : 0.55 }}
                    >
                        <div className="adm-color-row">
                            <input
                                type="checkbox"
                                aria-label={`Use ${QUESTION_BY_ID.get(q.id)?.label ?? q.id}`}
                                checked={q.enabled}
                                disabled={disabled}
                                onChange={(e) =>
                                    onChange(questions.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))
                                }
                            />
                            <span className="adm-party-name" style={{ flex: 1 }}>
                                {i + 1}. {QUESTION_BY_ID.get(q.id)?.label ?? q.id}
                            </span>
                            <button
                                type="button"
                                className="adm-btn"
                                aria-label="Move up"
                                disabled={disabled || i === 0}
                                onClick={() => moveQuestion(i, i - 1)}
                            >
                                ↑
                            </button>
                            <button
                                type="button"
                                className="adm-btn"
                                aria-label="Move down"
                                disabled={disabled || i === questions.length - 1}
                                onClick={() => moveQuestion(i, i + 1)}
                            >
                                ↓
                            </button>
                        </div>
                    </li>
                ))}
            </ol>
        </div>
    );
}
