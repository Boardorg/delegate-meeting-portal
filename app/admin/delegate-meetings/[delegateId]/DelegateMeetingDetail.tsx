"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fmtTime, fmtWeekday } from "@/lib/format";
import type { SyncReport } from "@/lib/cvent/syncReport";
import type { SlotOption } from "@/lib/scheduling/slotOptions";
import SyncReportPanel from "../../meetings/SyncReportPanel";
import { StatChip } from "../../meetings/_components/StatChip";
import { SlotSelect } from "../../meetings/_components/SlotSelect";
import { LegendItem, SourceChip, SyncChip } from "../../meetings/_components/MeetingChips";
import {
    getD2DSlotOptions,
    moveD2DMeeting,
    pushAllForDelegate,
    pushD2DMeeting,
    removeD2DMeeting,
    type DelegateDetail,
    type DelegateMeetingRow,
} from "./actions";

// ---------------------------------------------------------------------------
// DelegateMeetingDetail — one delegate's meetings, for /admin/delegate-meetings/[delegateId].
//
// Mirrors MeetingDetail on a sponsor's page.
// D2D meetings can be moved to another D2D slot, removed or pushed.
// S2D meetings and appointments only in Cvent are shown read-only for context.
// ---------------------------------------------------------------------------

type Props = {
    delegate: DelegateDetail;
    meetings: DelegateMeetingRow[];
    eventCode: string;
    /** The event's IANA timezone, for slot times. */
    timezone: string;
};

/** Plain words for why a delegate can't be matched. */
const EXCLUSION_LABEL: Record<NonNullable<DelegateDetail["exclusion"]>, string> = {
    conference_only: "Conference only, so no D2D meetings",
    incomplete_profile: "Networking Profile not complete, so no D2D matching",
    cancelled: "Cancelled in Cvent",
};

/**
 * Renders a delegate's meetings with their actions.
 *
 * @param {Props} props - The delegate, their meetings, the event and its timezone.
 * @returns {JSX.Element} The page body.
 */
export default function DelegateMeetingDetail({ delegate, meetings, eventCode, timezone }: Props) {
    const router = useRouter();
    const [editTarget, setEditTarget] = useState<DelegateMeetingRow | null>(null);
    const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
    const [pushResult, setPushResult] = useState<SyncReport | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    const readOnlyCount = meetings.filter((m) => m.readOnly).length;

    /**
     * Removes a D2D meeting, cancelling it in Cvent first when it was pushed.
     *
     * @param {string} id - The meeting id.
     */
    function handleRemove(id: string) {
        startTransition(async () => {
            const result = await removeD2DMeeting({ id });
            setConfirmRemoveId(null);
            setActionError(result.ok ? null : result.error);
            router.refresh();
        });
    }

    /**
     * Pushes one D2D meeting.
     *
     * @param {string} id - The meeting id.
     */
    function handlePush(id: string) {
        startTransition(async () => {
            setPushResult(await pushD2DMeeting({ id, eventCode }));
            router.refresh();
        });
    }

    /** Pushes every unsynced D2D meeting of this delegate. */
    function handlePushAll() {
        startTransition(async () => {
            setPushResult(await pushAllForDelegate({ delegateId: delegate.delegateId, eventCode }));
            router.refresh();
        });
    }

    return (
        <div className="adm-page">
            <nav className="adm-breadcrumb">
                <Link href="/admin/delegate-meetings">Delegate Meetings</Link>
                <span className="adm-breadcrumb-sep">›</span>
                <span>{delegate.name}</span>
            </nav>

            <div className="adm-card">
                <div className="adm-card-head">
                    <div>
                        <div className="adm-card-title">{delegate.name}</div>
                        <div className="adm-card-sub">
                            {[delegate.title, delegate.company].filter(Boolean).join(" · ")}
                        </div>
                        {delegate.exclusion && (
                            <div className="adm-card-sub">
                                <span className="adm-chip adm-chip-cancelled">{EXCLUSION_LABEL[delegate.exclusion]}</span>
                            </div>
                        )}
                    </div>
                </div>
                <div className="adm-card-row">
                    <StatChip label="S2D Meetings" value={String(delegate.s2dCount)} />
                    <StatChip
                        label="D2D Meetings"
                        value={`${delegate.d2dCount} / ${delegate.d2dCap}`}
                        valueColor={delegate.d2dCount > delegate.d2dCap ? "var(--red)" : undefined}
                    />
                    <button
                        type="button"
                        className="adm-new-btn adm-new-btn-primary adm-ml-auto"
                        disabled={isPending}
                        onClick={handlePushAll}
                    >
                        Push All to Cvent
                    </button>
                </div>
            </div>

            {pushResult && <SyncReportPanel report={pushResult} onDismiss={() => setPushResult(null)} />}
            {actionError && <div className="adm-modal-error">{actionError}</div>}

            <div className="adm-table-toolbar">
                <div className="adm-legend">
                    <LegendItem
                        swatch={{ width: 12, height: 12, borderRadius: 2, background: "var(--blue-s)", border: "1px solid var(--blue-b)" }}
                        label="D2D, portal-managed"
                    />
                    <LegendItem
                        swatch={{ width: 12, height: 12, borderRadius: 2, background: "var(--s3)", border: "1px solid var(--border)" }}
                        label="S2D or Cvent-native (read-only)"
                    />
                    <LegendItem
                        swatch={{ width: 12, height: 3, borderRadius: 1, background: "var(--gold)" }}
                        label="Weak match"
                    />
                </div>
            </div>

            {readOnlyCount > 0 && (
                <p className="adm-help-note">
                    Sponsor meetings are managed on the Sponsor Meetings page. Meetings made in Cvent can only
                    be changed in Cvent. Both count toward this delegate&apos;s meeting cap.
                </p>
            )}

            {meetings.length === 0 ? (
                <div className="adm-empty adm-empty-lg">No meetings scheduled yet.</div>
            ) : (
                <div className="adm-table-scroll">
                    <table className="adm-table adm-table-wide">
                        <thead>
                            <tr>
                                <th>With</th>
                                <th>Company</th>
                                <th>What They Share</th>
                                <th>Day</th>
                                <th>Time Slot</th>
                                <th>Location</th>
                                <th>Cvent Sync</th>
                                <th>Source</th>
                                <th className="adm-actions-col">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {meetings.map((m) => (
                                <DelegateMeetingTableRow
                                    key={m.id}
                                    meeting={m}
                                    timezone={timezone}
                                    isPending={isPending}
                                    isConfirmingRemove={confirmRemoveId === m.id}
                                    onEdit={() => setEditTarget(m)}
                                    onAskRemove={() => setConfirmRemoveId(m.id)}
                                    onCancelRemove={() => setConfirmRemoveId(null)}
                                    onConfirmRemove={() => handleRemove(m.id)}
                                    onPush={() => handlePush(m.id)}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {editTarget && (
                <MoveMeetingModal
                    meeting={editTarget}
                    eventCode={eventCode}
                    timezone={timezone}
                    onClose={() => setEditTarget(null)}
                    onSaved={() => {
                        setEditTarget(null);
                        router.refresh();
                    }}
                />
            )}
        </div>
    );
}

/**
 * One meeting row, with Edit, Remove and Push for portal D2D meetings.
 *
 * @param {{ meeting: DelegateMeetingRow; timezone: string; isPending: boolean; isConfirmingRemove: boolean; onEdit: () => void; onAskRemove: () => void; onCancelRemove: () => void; onConfirmRemove: () => void; onPush: () => void }} props
 * @returns {JSX.Element} The table row.
 */
function DelegateMeetingTableRow({
    meeting: m,
    timezone,
    isPending,
    isConfirmingRemove,
    onEdit,
    onAskRemove,
    onCancelRemove,
    onConfirmRemove,
    onPush,
}: {
    meeting: DelegateMeetingRow;
    timezone: string;
    isPending: boolean;
    isConfirmingRemove: boolean;
    onEdit: () => void;
    onAskRemove: () => void;
    onCancelRemove: () => void;
    onConfirmRemove: () => void;
    onPush: () => void;
}) {
    const showPush = !m.readOnly && m.syncStatus !== "synced";
    return (
        <tr className={`adm-row${m.weak ? " adm-row-conflict" : ""}${m.readOnly ? " adm-row-muted" : ""}`}>
            <td>
                <div className="adm-party-name">{m.otherName}</div>
                <div className="adm-chip-mt">
                    <span className={`adm-chip ${m.kind === "d2d" ? "adm-chip-sponsor-choice" : "adm-chip-admin"}`}>
                        {m.kind === "d2d" ? "D2D" : "S2D"}
                    </span>
                    {m.isHost && (
                        <>
                            {" "}
                            <span className="adm-chip adm-chip-mutual">Hosts in Cvent</span>
                        </>
                    )}
                    {m.otherCancelled && (
                        <>
                            {" "}
                            <span className="adm-chip adm-chip-cancelled">Cancelled in Cvent</span>
                        </>
                    )}
                </div>
            </td>
            <td>
                <div className="adm-party-company">{m.otherCompany || "—"}</div>
            </td>
            <td>
                {m.kind === "d2d" && m.score !== null ? (
                    <span className="adm-text-sm-muted">
                        {m.shared}
                        {m.weak && <span title="Below the minimum score"> ⚠ weak match</span>}
                        <span className="adm-mono-dim"> · {m.score}</span>
                    </span>
                ) : (
                    <span className="adm-dim">—</span>
                )}
            </td>
            <td>
                <span className={m.startTime ? "adm-text-sm-muted" : "adm-text-sm-dim"}>
                    {fmtWeekday(m.startTime, timezone)}
                </span>
            </td>
            <td>
                <span className={m.startTime ? "adm-mono-sm" : "adm-mono-sm adm-dim"}>
                    {fmtTime(m.startTime, timezone)}
                </span>
            </td>
            <td>
                <span className={m.location ? "adm-text-sm-muted" : "adm-text-sm-dim"}>{m.location || "—"}</span>
            </td>
            <td>
                <SyncChip status={m.syncStatus} />
            </td>
            <td>
                <SourceChip source={m.source} />
            </td>
            <td className="adm-actions-cell">
                <div className="adm-actions-inner">
                    {m.readOnly ? null : isConfirmingRemove ? (
                        <>
                            <span className="adm-confirm-label">Remove?</span>
                            <button type="button" className="adm-btn adm-btn-danger" onClick={onConfirmRemove} disabled={isPending}>
                                Yes
                            </button>
                            <button type="button" className="adm-btn" onClick={onCancelRemove} disabled={isPending}>
                                No
                            </button>
                        </>
                    ) : (
                        <>
                            <button type="button" className="adm-btn" onClick={onEdit} disabled={isPending}>
                                Edit
                            </button>
                            <button type="button" className="adm-btn adm-btn-danger" onClick={onAskRemove} disabled={isPending}>
                                Remove
                            </button>
                            {showPush && (
                                <button type="button" className="adm-btn adm-btn-primary" onClick={onPush} disabled={isPending}>
                                    Push
                                </button>
                            )}
                        </>
                    )}
                </div>
            </td>
        </tr>
    );
}

/**
 * The window for moving a D2D meeting to another D2D slot.
 *
 * @param {{ meeting: DelegateMeetingRow; eventCode: string; timezone: string; onClose: () => void; onSaved: () => void }} props
 * @returns {JSX.Element} The window.
 */
function MoveMeetingModal({
    meeting,
    eventCode,
    timezone,
    onClose,
    onSaved,
}: {
    meeting: DelegateMeetingRow;
    eventCode: string;
    timezone: string;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [options, setOptions] = useState<SlotOption[] | null>(null);
    const [selected, setSelected] = useState("");
    const [loadError, setLoadError] = useState<string | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    // Load the D2D slots both delegates are free for when the window opens.
    useEffect(() => {
        getD2DSlotOptions({ meetingId: meeting.id, eventCode })
            .then(({ current, options: opts }) => {
                setOptions(opts);
                if (current && opts.some((o) => o.timeslotId === current.timeslotId)) setSelected(current.timeslotId);
            })
            .catch(() => setLoadError("Failed to load slot options."));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** Saves the chosen slot. The server re-checks it and says why when it refuses. */
    function handleSave() {
        if (!selected) return;
        startTransition(async () => {
            try {
                setSaveError(null);
                const result = await moveD2DMeeting({ id: meeting.id, eventCode, timeslotId: selected });
                if (!result.ok) {
                    setSaveError(result.error);
                    return;
                }
                onSaved();
            } catch (e) {
                setSaveError(e instanceof Error ? e.message : "Failed to save.");
            }
        });
    }

    return (
        <div className="adm-modal-overlay">
            <div className="adm-modal adm-modal-sm">
                <div className="adm-modal-title-sm">Edit Meeting</div>
                <div className="adm-modal-sub">
                    {meeting.otherName}
                    {meeting.otherCompany ? ` · ${meeting.otherCompany}` : ""}
                </div>
                {loadError ? (
                    <div className="adm-modal-load-error">{loadError}</div>
                ) : options === null ? (
                    <div className="adm-modal-loading">Loading slots…</div>
                ) : (
                    <label className="adm-field adm-field-mb-lg">
                        <span className="adm-field-label">Time Slot</span>
                        <SlotSelect
                            options={options}
                            value={selected}
                            onChange={setSelected}
                            disabled={isPending}
                            timezone={timezone}
                        />
                    </label>
                )}
                {saveError && <div className="adm-modal-error">{saveError}</div>}
                <div className="adm-modal-actions">
                    <button type="button" className="adm-btn" onClick={onClose} disabled={isPending}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="adm-btn adm-btn-primary"
                        onClick={handleSave}
                        disabled={isPending || options === null || !selected}
                    >
                        {isPending ? "Saving…" : "Save"}
                    </button>
                </div>
            </div>
        </div>
    );
}
