"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fmtTime } from "@/lib/format";
import type { MeetingMatchKind, MeetingSource } from "@/lib/db/schema";
import type { SponsorDetail } from "@/types";
import type { PushSummary } from "@/lib/cvent/push";
import {
    createMeeting,
    editMeeting,
    getNewMeetingSlots,
    getSlotOptions,
    listDelegates,
    pushAllForSponsor,
    pushMeeting,
    removeMeeting,
    type DelegateOption,
    type LocationOption,
    type MeetingRow,
    type SlotOption,
    type SyncStatus,
} from "./actions";
import { TierPill } from "../_components/TierPill";

// ---------------------------------------------------------------------------
// MeetingDetail — per-sponsor meeting table for /admin/meetings/[sponsorId].
// ---------------------------------------------------------------------------

type Props = {
    sponsor: SponsorDetail;
    meetings: MeetingRow[];
    eventCode: string;
};

export default function MeetingDetail({ sponsor, meetings, eventCode }: Props) {
    const router = useRouter();
    const total = sponsor.contracted + sponsor.bonus;
    const listHref = `/admin/meetings`;

    const [editTarget, setEditTarget] = useState<MeetingRow | null>(null);
    const [showCreate, setShowCreate] = useState(false);
    const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
    const [pushResult, setPushResult] = useState<PushSummary | null>(null);
    const [isPending, startTransition] = useTransition();

    // Detect duplicate delegate companies within this sponsor's meetings.
    const conflictCompanies = useMemo(() => {
        const counts = new Map<string, number>();
        for (const m of meetings) {
            if (m.delegateCompany)
                counts.set(m.delegateCompany, (counts.get(m.delegateCompany) ?? 0) + 1);
        }
        return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([c]) => c));
    }, [meetings]);

    // Handler for removing a meeting.
    function handleRemove(id: string) {
        startTransition(async () => {
            await removeMeeting({ id });
            setConfirmRemoveId(null);
            router.refresh();
        });
    }

    // Handler for pushing a single meeting.
    function handlePush(id: string) {
        startTransition(async () => {
            const result = await pushMeeting({ id, eventCode });
            setPushResult(result);
            router.refresh();
        });
    }

    // Handler for pushing all meetings for the sponsor.
    function handlePushAll() {
        startTransition(async () => {
            const result = await pushAllForSponsor({ sponsorId: sponsor.salesforceId, eventCode });
            setPushResult(result);
            router.refresh();
        });
    }

    // Render the meeting detail page.
    return (
        <div className="adm-page">
            {/* Breadcrumb */}
            <nav className="adm-breadcrumb">
                <Link href={listHref}>Manage Meetings</Link>
                <span className="adm-breadcrumb-sep">›</span>
                <span>{sponsor.company}</span>
            </nav>

            {/* Sponsor header */}
            <div className="adm-card">
                <div className="adm-card-head">
                    <div>
                        <div className="adm-card-title">{sponsor.company}</div>
                        <div className="adm-card-sub">
                            {sponsor.name} · {sponsor.title} ·{" "}
                            <TierPill tier={sponsor.sponsorTier} />
                        </div>
                    </div>
                </div>

                {/* Stat chips + push all */}
                <div className="adm-card-row">
                    <StatChip label="Contracted" value={String(sponsor.contracted)} />
                    <StatChip
                        label="Bonus"
                        value={sponsor.bonus > 0 ? `+${sponsor.bonus}` : "—"}
                    />
                    <StatChip label="Total Target" value={String(total)} />
                    <StatChip label="Requests Filed" value={String(sponsor.requestCount)} />
                    <StatChip
                        label="Scheduled"
                        value={`${sponsor.scheduledCount} / ${total}`}
                        valueColor={
                            sponsor.scheduledCount > total
                                ? "var(--red)"
                                : sponsor.scheduledCount === total
                                  ? "var(--green)"
                                  : sponsor.scheduledCount > 0
                                    ? "var(--text)"
                                    : "var(--gold)"
                        }
                    />
                    <button
                        type="button"
                        className="adm-new-btn adm-ml-auto"
                        disabled={isPending}
                        onClick={handlePushAll}
                    >
                        Push All to Cvent
                    </button>
                </div>
            </div>

            {/* Push-to-Cvent result banner */}
            {pushResult && (
                <PushResultBanner
                    result={pushResult}
                    onDismiss={() => setPushResult(null)}
                />
            )}

            {/* Legend + create button */}
            <div className="adm-table-toolbar">
                <div className="adm-legend">
                    <LegendItem
                        swatch={{ width: 12, height: 12, borderRadius: 2, background: "var(--blue-s)", border: "1px solid var(--blue-b)" }}
                        label="Portal-managed"
                    />
                    <LegendItem
                        swatch={{ width: 12, height: 12, borderRadius: 2, background: "var(--s3)", border: "1px solid var(--border)" }}
                        label="Cvent-native (read-only)"
                    />
                    <LegendItem
                        swatch={{ width: 12, height: 3, borderRadius: 1, background: "var(--gold)" }}
                        label="Duplicate company conflict"
                    />
                </div>
                <button
                    type="button"
                    className="adm-new-btn"
                    onClick={() => setShowCreate(true)}
                >
                    + Create Meeting
                </button>
            </div>

            {/* Meeting table */}
            {meetings.length === 0 ? (
                <div className="adm-empty adm-empty-lg">
                    No meetings scheduled yet.
                </div>
            ) : (
                <div className="adm-table-scroll">
                    <table className="adm-table adm-table-wide">
                        <thead>
                            <tr>
                                <th>Delegate</th>
                                <th>Company</th>
                                <th>Rank</th>
                                <th>Time Slot</th>
                                <th>Location</th>
                                <th>Cvent Sync</th>
                                <th>Source</th>
                                <th className="adm-actions-col">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {meetings.map((m) => (
                                <MeetingTableRow
                                    key={m.id}
                                    meeting={m}
                                    hasConflict={conflictCompanies.has(m.delegateCompany)}
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

            {/* Edit meeting modal */}
            {editTarget && (
                <EditMeetingModal
                    meeting={editTarget}
                    eventCode={eventCode}
                    onClose={() => setEditTarget(null)}
                    onSaved={() => { setEditTarget(null); router.refresh(); }}
                />
            )}

            {/* Create meeting modal */}
            {showCreate && (
                <CreateMeetingModal
                    sponsorId={sponsor.salesforceId}
                    eventCode={eventCode}
                    scheduledCount={sponsor.scheduledCount}
                    meetingTarget={total}
                    onClose={() => setShowCreate(false)}
                    onCreated={() => { setShowCreate(false); router.refresh(); }}
                />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// PushResultBanner — shows the outcome of a push to Cvent.
// ---------------------------------------------------------------------------

function PushResultBanner({
    result,
    onDismiss,
}: {
    result: PushSummary;
    onDismiss: () => void;
}) {
    const allOk = result.failed === 0 && result.total > 0;
    const nothing = result.total === 0;
    const failures = result.results.filter((r) => !r.ok);

    // Accent color: green (all pushed), red (any failed), muted (nothing to push).
    const accent = nothing ? "var(--border)" : allOk ? "var(--green)" : "var(--red)";

    return (
        <div
            className="adm-card"
            style={{ borderLeft: `3px solid ${accent}`, marginBottom: 12 }}
            role="status"
        >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>
                        {nothing
                            ? "Nothing to push — all meetings are already synced."
                            : `${allOk ? "✓" : "⚠"} Pushed ${result.pushed} of ${result.total} to Cvent` +
                              (result.failed > 0 ? ` · ${result.failed} failed` : "")}
                    </div>

                    {failures.length > 0 && (
                        <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                            {failures.map((f) => (
                                <li
                                    key={f.meetingId}
                                    style={{
                                        fontSize: 13,
                                        marginBottom: 4,
                                        color: "var(--red)",
                                        // Expanded (testing-mode) errors can be multi-line.
                                        whiteSpace: "pre-wrap",
                                    }}
                                >
                                    <span style={{ color: "var(--text)", fontWeight: 500 }}>
                                        {f.label}:
                                    </span>{" "}
                                    {f.error ?? "Unknown error"}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <button type="button" className="adm-link-btn" onClick={onDismiss}>
                    Dismiss
                </button>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// MeetingTableRow
// ---------------------------------------------------------------------------

function MeetingTableRow({
    meeting: m,
    hasConflict,
    isPending,
    isConfirmingRemove,
    onEdit,
    onAskRemove,
    onCancelRemove,
    onConfirmRemove,
    onPush,
}: {
    meeting: MeetingRow;
    hasConflict: boolean;
    isPending: boolean;
    isConfirmingRemove: boolean;
    onEdit: () => void;
    onAskRemove: () => void;
    onCancelRemove: () => void;
    onConfirmRemove: () => void;
    onPush: () => void;
}) {
    const isCvent = m.source === "cvent";
    const showPush = !isCvent && m.syncStatus !== "synced";

    return (
        <tr className={`adm-row${hasConflict ? " adm-row-conflict" : ""}${isCvent ? " adm-row-muted" : ""}`}>
            {/* Delegate */}
            <td>
                <div className="adm-party-name">{m.delegateName}</div>
                <div className="adm-chip-mt">
                    <MatchKindChip kind={m.matchKind} />
                </div>
            </td>

            {/* Company */}
            <td>
                <div className={`adm-party-company adm-party-company-row${hasConflict ? " adm-party-conflict" : ""}`}>
                    {hasConflict && <span title="Duplicate company">⚠</span>}
                    {m.delegateCompany || "—"}
                </div>
            </td>

            {/* Rank */}
            <td>
                {m.rank != null ? (
                    <span className="adm-rank-badge">{m.rank}</span>
                ) : (
                    <span className="adm-dim">—</span>
                )}
            </td>

            {/* Time slot */}
            <td>
                <span className={m.startTime ? "adm-mono-sm" : "adm-mono-sm adm-dim"}>
                    {fmtTime(m.startTime)}
                </span>
            </td>

            {/* Location */}
            <td>
                <span className={m.location ? "adm-text-sm-muted" : "adm-text-sm-dim"}>
                    {m.location || "—"}
                </span>
            </td>

            {/* Cvent Sync */}
            <td>
                <SyncChip status={m.syncStatus} />
            </td>

            {/* Source */}
            <td>
                <SourceChip source={m.source} />
            </td>

            {/* Actions */}
            <td className="adm-actions-cell">
                <div className="adm-actions-inner">
                    {isCvent ? null : isConfirmingRemove ? (
                        <>
                            <span className="adm-confirm-label">Remove?</span>
                            <button
                                type="button"
                                className="adm-btn adm-btn-danger"
                                onClick={onConfirmRemove}
                                disabled={isPending}
                            >
                                Yes
                            </button>
                            <button
                                type="button"
                                className="adm-btn"
                                onClick={onCancelRemove}
                                disabled={isPending}
                            >
                                No
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                type="button"
                                className="adm-btn"
                                onClick={onEdit}
                                disabled={isPending}
                            >
                                Edit
                            </button>
                            <button
                                type="button"
                                className="adm-btn adm-btn-danger"
                                onClick={onAskRemove}
                                disabled={isPending}
                            >
                                Remove
                            </button>
                            {showPush && (
                                <button
                                    type="button"
                                    className="adm-btn adm-btn-primary"
                                    onClick={onPush}
                                    disabled={isPending}
                                >
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

// ---------------------------------------------------------------------------
// EditMeetingModal
// ---------------------------------------------------------------------------

function EditMeetingModal({
    meeting,
    eventCode,
    onClose,
    onSaved,
}: {
    meeting: MeetingRow;
    eventCode: string;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [options, setOptions] = useState<SlotOption[] | null>(null);
    const [selectedKey, setSelectedKey] = useState<string>("");
    const [locations, setLocations] = useState<LocationOption[]>([]);
    const [locationId, setLocationId] = useState(meeting.locationId ?? "");
    const [loadError, setLoadError] = useState<string | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    // Load available timeslot + location options when the modal opens.
    useEffect(() => {
        getSlotOptions({ meetingId: meeting.id, eventCode })
            .then(({ current, options: opts, locations: locs }) => {
                setOptions(opts);
                setLocations(locs);
                if (current) setSelectedKey(slotKey(current));
            })
            .catch(() => setLoadError("Failed to load slot options."));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // A timeslot id uniquely identifies an option.
    function slotKey(o: SlotOption): string {
        return o.timeslotId;
    }

    // Handler for saving the edited meeting.
    function handleSave() {
        const opt = options?.find((o) => slotKey(o) === selectedKey);
        if (!opt) return;
        startTransition(async () => {
            try {
                setSaveError(null);
                await editMeeting({
                    id: meeting.id,
                    timeslotId: opt.timeslotId,
                    day: opt.day,
                    locationId: locationId || null,
                });
                onSaved();
            } catch (e) {
                setSaveError(e instanceof Error ? e.message : "Failed to save.");
            }
        });
    }

    // Render the edit meeting modal.
    return (
        <div className="adm-modal-overlay">
            <div className="adm-modal adm-modal-sm">
                <div className="adm-modal-title-sm">Edit Meeting</div>
                <div className="adm-modal-sub">
                    {meeting.delegateName}
                    {meeting.delegateCompany ? ` · ${meeting.delegateCompany}` : ""}
                </div>

                {loadError ? (
                    <div className="adm-modal-load-error">{loadError}</div>
                ) : options === null ? (
                    <div className="adm-modal-loading">Loading slots…</div>
                ) : (
                    <>
                        <label className="adm-field adm-field-mb">
                            <span className="adm-field-label">Time Slot</span>
                            <select
                                className="adm-input adm-select"
                                value={selectedKey}
                                onChange={(e) => setSelectedKey(e.target.value)}
                                disabled={isPending}
                            >
                                {options.map((o) => (
                                    <option key={slotKey(o)} value={slotKey(o)}>
                                        Day {o.day} – {fmtTime(o.startTime)}
                                        {o.locationName ? ` · ${o.locationName}` : ""}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="adm-field adm-field-mb-lg">
                            <span className="adm-field-label">Location</span>
                            <select
                                className="adm-input adm-select"
                                value={locationId}
                                onChange={(e) => setLocationId(e.target.value)}
                                disabled={isPending}
                            >
                                <option value="">— No location —</option>
                                {locations.map((l) => (
                                    <option key={l.id} value={l.id}>
                                        {l.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </>
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
                        disabled={isPending || options === null || !selectedKey}
                    >
                        {isPending ? "Saving…" : "Save"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// CreateMeetingModal — two-phase: pick a delegate, then pick a slot + location.
// ---------------------------------------------------------------------------

function CreateMeetingModal({
    sponsorId,
    eventCode,
    scheduledCount,
    meetingTarget,
    onClose,
    onCreated,
}: {
    sponsorId: string;
    eventCode: string;
    scheduledCount: number;
    meetingTarget: number;
    onClose: () => void;
    onCreated: () => void;
}) {
    const [delegates, setDelegates] = useState<DelegateOption[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [selected, setSelected] = useState<DelegateOption | null>(null);
    const [slotOptions, setSlotOptions] = useState<SlotOption[] | null>(null);
    const [slotsLoading, setSlotsLoading] = useState(false);
    const [selectedKey, setSelectedKey] = useState("");
    const [locations, setLocations] = useState<LocationOption[]>([]);
    const [locationId, setLocationId] = useState("");
    const [saveError, setSaveError] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    // Load the list of delegates when the modal opens.
    useEffect(() => {
        listDelegates({ eventCode })
            .then(setDelegates)
            .catch(() => setLoadError("Failed to load delegates."));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // A timeslot id uniquely identifies an option.
    function slotKey(o: SlotOption): string {
        return o.timeslotId;
    }

    // Handler for selecting a delegate.
    function selectDelegate(d: DelegateOption) {
        setSelected(d);
        setSlotOptions(null);
        setSelectedKey("");
        setSlotsLoading(true);
        getNewMeetingSlots({ sponsorId, delegateId: d.salesforceId, eventCode })
            .then(({ options, locations: locs }) => {
                setSlotOptions(options);
                setLocations(locs);
                if (options.length > 0) setSelectedKey(slotKey(options[0]));
            })
            .catch(() => setSlotOptions([]))
            .finally(() => setSlotsLoading(false));
    }

    // Handler for creating a new meeting.
    function handleCreate() {
        const opt = slotOptions?.find((o) => slotKey(o) === selectedKey);
        if (!opt || !selected) return;
        startTransition(async () => {
            try {
                setSaveError(null);
                await createMeeting({
                    eventCode,
                    sponsorId,
                    delegateId: selected.salesforceId,
                    timeslotId: opt.timeslotId,
                    day: opt.day,
                    locationId: locationId || null,
                });
                onCreated();
            } catch (e) {
                setSaveError(e instanceof Error ? e.message : "Failed to create meeting.");
            }
        });
    }

    // Filter delegates based on search query.
    const filtered = delegates
        ? delegates.filter(
              (d) =>
                  !search.trim() ||
                  d.name.toLowerCase().includes(search.toLowerCase()) ||
                  d.company.toLowerCase().includes(search.toLowerCase()),
          )
        : [];

    // Render the create meeting modal.
    return (
        <div className="adm-modal-overlay">
            <div className="adm-modal adm-modal-lg">
                <div className="adm-modal-title">Create Meeting</div>

                {/* Warning if sponsor has reached or exceeded their meeting target. */}
                {scheduledCount >= meetingTarget && (
                    <div className={scheduledCount > meetingTarget ? "adm-modal-warn-over" : "adm-modal-warn-at"}>
                        {scheduledCount > meetingTarget
                            ? `This sponsor is over target (${scheduledCount} of ${meetingTarget} scheduled).`
                            : `This sponsor has reached their meeting target (${scheduledCount} of ${meetingTarget}).`}
                    </div>
                )}

                {/* Delegate picker */}
                <div>
                    <div className="adm-field-label adm-field-mb-sm">
                        {selected ? (
                            <span>
                                Delegate:{" "}
                                <strong>
                                    {selected.name}
                                    {selected.company ? ` · ${selected.company}` : ""}
                                </strong>{" "}
                                <button
                                    type="button"
                                    className="adm-link-btn"
                                    onClick={() => { setSelected(null); setSlotOptions(null); setSelectedKey(""); }}
                                >
                                    Change
                                </button>
                            </span>
                        ) : (
                            "Select Delegate"
                        )}
                    </div>

                    {!selected && (
                        <>
                            <input
                                type="search"
                                className="adm-input adm-delegate-search"
                                placeholder="Search by name or company…"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                            {loadError ? (
                                <div className="adm-modal-load-error">{loadError}</div>
                            ) : delegates === null ? (
                                <div className="adm-dim">Loading…</div>
                            ) : (
                                <div className="adm-delegate-list">
                                    {filtered.length === 0 ? (
                                        <div className="adm-delegate-empty">No delegates found.</div>
                                    ) : (
                                        filtered.map((d) => (
                                            <button
                                                key={d.salesforceId}
                                                type="button"
                                                className="adm-delegate-option"
                                                onClick={() => selectDelegate(d)}
                                            >
                                                <span>{d.name}</span>
                                                {d.company && (
                                                    <span className="adm-delegate-company">{d.company}</span>
                                                )}
                                            </button>
                                        ))
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Slot + location (shown after delegate selected) */}
                {selected && (
                    <>
                        <label className="adm-field">
                            <span className="adm-field-label">Time Slot</span>
                            {slotsLoading ? (
                                <span className="adm-dim">Loading slots…</span>
                            ) : slotOptions && slotOptions.length === 0 ? (
                                <span className="adm-gold-sm">
                                    No mutual available timeslots for this pair.
                                </span>
                            ) : (
                                <select
                                    className="adm-input adm-select"
                                    value={selectedKey}
                                    onChange={(e) => setSelectedKey(e.target.value)}
                                    disabled={isPending || !slotOptions}
                                >
                                    {(slotOptions ?? []).map((o) => (
                                        <option key={o.timeslotId} value={o.timeslotId}>
                                            Day {o.day} – {fmtTime(o.startTime)}
                                            {o.locationName ? ` · ${o.locationName}` : ""}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </label>

                        <label className="adm-field">
                            <span className="adm-field-label">Location</span>
                            <select
                                className="adm-input adm-select"
                                value={locationId}
                                onChange={(e) => setLocationId(e.target.value)}
                                disabled={isPending}
                            >
                                <option value="">— No location —</option>
                                {locations.map((l) => (
                                    <option key={l.id} value={l.id}>
                                        {l.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </>
                )}

                {saveError && <div className="adm-modal-error">{saveError}</div>}

                <div className="adm-modal-actions">
                    <button type="button" className="adm-btn" onClick={onClose} disabled={isPending}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="adm-btn adm-btn-primary"
                        onClick={handleCreate}
                        disabled={isPending || !selected || !selectedKey || slotsLoading}
                    >
                        {isPending ? "Creating…" : "Create Meeting"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Chips + small display components
// ---------------------------------------------------------------------------

function MatchKindChip({ kind }: { kind: MeetingMatchKind }) {
    const classMap: Record<MeetingMatchKind, string> = {
        mutual:          "adm-chip-mutual",
        sponsor_choice:  "adm-chip-sponsor-choice",
        delegate_choice: "adm-chip-delegate-choice",
        admin:           "adm-chip-admin",
    };
    const labelMap: Record<MeetingMatchKind, string> = {
        mutual:          "Mutual",
        sponsor_choice:  "Sponsor choice",
        delegate_choice: "Delegate choice",
        admin:           "Admin created",
    };
    return <span className={`adm-chip ${classMap[kind]}`}>{labelMap[kind]}</span>;
}

function SyncChip({ status }: { status: SyncStatus }) {
    const classMap: Record<SyncStatus, string> = {
        synced:     "adm-chip-synced",
        modified:   "adm-chip-modified",
        not_pushed: "adm-chip-not-pushed",
    };
    const labelMap: Record<SyncStatus, string> = {
        synced:     "Synced",
        modified:   "Modified",
        not_pushed: "Not pushed",
    };
    return <span className={`adm-chip ${classMap[status]}`}>{labelMap[status]}</span>;
}

function SourceChip({ source }: { source: MeetingSource }) {
    return (
        <span className={`adm-chip ${source === "portal" ? "adm-chip-portal" : "adm-chip-cvent"}`}>
            {source === "portal" ? "Portal" : "Cvent"}
        </span>
    );
}

function StatChip({ label, value, valueColor }: { label: string; value: string; valueColor?: string; }) {
    return (
        <div className="adm-stat-chip">
            <span className="adm-stat-label">{label}</span>
            <span className="adm-stat-value" style={valueColor ? { color: valueColor } : undefined}>
                {value}
            </span>
        </div>
    );
}

function LegendItem({ swatch, label }: { swatch: React.CSSProperties; label: string; }) {
    return (
        <span className="adm-legend-item">
            <span className="adm-legend-swatch" style={swatch} />
            {label}
        </span>
    );
}
