"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fmtTime } from "@/lib/format";
import type { MeetingMatchKind, MeetingSource } from "@/types";
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
    type MeetingRow,
    type SlotOption,
    type SponsorDetail,
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
    const listHref = `/admin/meetings?event=${encodeURIComponent(eventCode)}`;

    const [editTarget, setEditTarget] = useState<MeetingRow | null>(null);
    const [showCreate, setShowCreate] = useState(false);
    const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
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

    // Handler for pushing a meeting.
    function handlePush(id: string) {
        startTransition(async () => {
            await pushMeeting({ id });
            router.refresh();
        });
    }

    // Handler for pushing all meetings for the sponsor.
    function handlePushAll() {
        startTransition(async () => {
            await pushAllForSponsor({ sponsorId: sponsor.salesforceId, eventCode });
            router.refresh();
        });
    }

    // Render the meeting detail page.
    return (
        <div className="adm-page">
            {/* Breadcrumb */}
            <nav style={{ fontSize: "12px", color: "var(--t3)", marginBottom: "4px" }}>
                <Link
                    href={listHref}
                    style={{ color: "var(--t2)", textDecoration: "none" }}
                >
                    Manage Meetings
                </Link>
                <span style={{ margin: "0 6px" }}>›</span>
                <span>{sponsor.company}</span>
            </nav>

            {/* Sponsor header */}
            <div
                style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r-lg)",
                    padding: "20px 24px",
                    marginBottom: "20px",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: "16px",
                        marginBottom: "16px",
                        flexWrap: "wrap",
                    }}
                >
                    <div>
                        <div
                            style={{
                                fontFamily: "var(--display)",
                                fontSize: "20px",
                                fontWeight: 700,
                                letterSpacing: "-0.02em",
                            }}
                        >
                            {sponsor.company}
                        </div>
                        <div
                            style={{
                                fontSize: "13px",
                                color: "var(--t2)",
                                marginTop: "3px",
                            }}
                        >
                            {sponsor.name} · {sponsor.title} ·{" "}
                            <TierPill tier={sponsor.sponsorTier} />
                        </div>
                    </div>
                </div>

                {/* Stat chips + push all */}
                <div style={{ display: "flex", alignItems: "flex-end", gap: "10px", flexWrap: "wrap" }}>
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
                        className="adm-new-btn"
                        disabled={isPending}
                        onClick={handlePushAll}
                        style={{ marginLeft: "auto" }}
                    >
                        Push All to Cvent
                    </button>
                </div>
            </div>

            {/* Legend + create button */}
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px",
                    marginBottom: "14px",
                    flexWrap: "wrap",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "16px",
                        fontSize: "11px",
                        color: "var(--t2)",
                        flexWrap: "wrap",
                    }}
                >
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
                <div className="adm-empty" style={{ padding: "48px 24px" }}>
                    No meetings scheduled yet.
                </div>
            ) : (
                <div style={{ overflowX: "auto" }}>
                    <table
                        className="adm-table"
                        style={{ minWidth: "980px" }}
                    >
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
        <tr
            className="adm-row"
            style={{
                borderLeft: hasConflict ? "3px solid var(--gold)" : undefined,
                opacity: isCvent ? 0.7 : 1,
            }}
        >
            {/* Delegate */}
            <td>
                <div className="adm-party-name">{m.delegateName}</div>
                <div style={{ marginTop: "4px" }}>
                    <MatchKindChip kind={m.matchKind} />
                </div>
            </td>

            {/* Company */}
            <td>
                <div
                    className="adm-party-company"
                    style={{
                        color: hasConflict ? "var(--gold)" : undefined,
                        display: "flex",
                        alignItems: "center",
                        gap: "4px",
                    }}
                >
                    {hasConflict && <span title="Duplicate company">⚠</span>}
                    {m.delegateCompany || "—"}
                </div>
            </td>

            {/* Rank */}
            <td>
                {m.rank != null ? (
                    <span
                        style={{
                            width: 20,
                            height: 20,
                            borderRadius: "50%",
                            background: "var(--s3)",
                            border: "1px solid var(--border)",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "10px",
                            fontFamily: "var(--mono)",
                            color: "var(--t2)",
                        }}
                    >
                        {m.rank}
                    </span>
                ) : (
                    <span style={{ color: "var(--t3)", fontSize: "12px" }}>—</span>
                )}
            </td>

            {/* Time slot */}
            <td>
                <span
                    style={{
                        fontFamily: "var(--mono)",
                        fontSize: "11px",
                        color: m.startTime ? "var(--text)" : "var(--t3)",
                    }}
                >
                    {fmtTime(m.startTime)}
                </span>
            </td>

            {/* Location */}
            <td>
                <span
                    style={{
                        fontSize: "11px",
                        color: m.location ? "var(--t2)" : "var(--t3)",
                    }}
                >
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
    const [location, setLocation] = useState(meeting.location ?? "");
    const [loadError, setLoadError] = useState<string | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    // Load available slot options when the modal opens.
    useEffect(() => {
        getSlotOptions({ meetingId: meeting.id, eventCode })
            .then(({ current, options: opts }) => {
                setOptions(opts);
                if (current) setSelectedKey(slotKey(current));
            })
            .catch(() => setLoadError("Failed to load slot options."));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Helper to create a unique key for a slot option based on its IDs.
    function slotKey(o: SlotOption): string {
        return `${o.slotIdA}|${o.slotIdB}`;
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
                    slotIdA: opt.slotIdA,
                    slotIdB: opt.slotIdB,
                    day: opt.day,
                    startTime: opt.startTime,
                    endTime: opt.endTime,
                    location: location || null,
                });
                onSaved();
            } catch (e) {
                setSaveError(e instanceof Error ? e.message : "Failed to save.");
            }
        });
    }

    // Render the edit meeting modal.
    return (
        <div
            style={{
                position: "fixed",
                inset: 0,
                zIndex: 50,
                background: "rgba(0,0,0,0.45)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "16px",
            }}
        >
            <div
                style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r-lg)",
                    padding: "28px 32px",
                    width: "100%",
                    maxWidth: "440px",
                }}
            >
                <div
                    style={{
                        fontFamily: "var(--display)",
                        fontSize: "16px",
                        fontWeight: 700,
                        marginBottom: "4px",
                    }}
                >
                    Edit Meeting
                </div>
                <div
                    style={{
                        fontSize: "12px",
                        color: "var(--t2)",
                        marginBottom: "20px",
                    }}
                >
                    {meeting.delegateName}
                    {meeting.delegateCompany ? ` · ${meeting.delegateCompany}` : ""}
                </div>

                {loadError ? (
                    <div style={{ fontSize: "12px", color: "var(--red, #e8391e)", marginBottom: "16px" }}>
                        {loadError}
                    </div>
                ) : options === null ? (
                    <div style={{ fontSize: "12px", color: "var(--t3)", marginBottom: "16px" }}>
                        Loading slots…
                    </div>
                ) : (
                    <>
                        <label className="adm-field" style={{ marginBottom: "14px", display: "flex", flexDirection: "column", gap: "4px" }}>
                            <span className="adm-field-label">Time Slot</span>
                            <select
                                className="adm-input adm-select"
                                style={{ width: "100%" }}
                                value={selectedKey}
                                onChange={(e) => setSelectedKey(e.target.value)}
                                disabled={isPending}
                            >
                                {options.map((o) => (
                                    <option key={slotKey(o)} value={slotKey(o)}>
                                        Day {o.day} – {fmtTime(o.startTime)}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="adm-field" style={{ marginBottom: "20px", display: "flex", flexDirection: "column", gap: "4px" }}>
                            <span className="adm-field-label">Location</span>
                            <input
                                type="text"
                                className="adm-input"
                                style={{ width: "100%" }}
                                placeholder="e.g. Table 3A"
                                value={location}
                                onChange={(e) => setLocation(e.target.value)}
                                disabled={isPending}
                            />
                        </label>
                    </>
                )}

                {saveError && (
                    <div
                        style={{
                            marginBottom: "16px",
                            padding: "10px 14px",
                            background: "rgba(232,57,30,0.08)",
                            border: "1px solid var(--red-b, rgba(232,57,30,0.3))",
                            borderRadius: "var(--r)",
                            fontSize: "12px",
                            color: "var(--red, #e8391e)",
                        }}
                    >
                        {saveError}
                    </div>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                    <button
                        type="button"
                        className="adm-btn"
                        onClick={onClose}
                        disabled={isPending}
                    >
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
    const [location, setLocation] = useState("");
    const [saveError, setSaveError] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    // Load the list of delegates when the modal opens.
    useEffect(() => {
        listDelegates({ eventCode })
            .then(setDelegates)
            .catch(() => setLoadError("Failed to load delegates."));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Helper to create a unique key for a slot option based on its IDs.
    function slotKey(o: SlotOption): string {
        return `${o.slotIdA}|${o.slotIdB}`;
    }

    // Handler for selecting a delegate.
    function selectDelegate(d: DelegateOption) {
        setSelected(d);
        setSlotOptions(null);
        setSelectedKey("");
        setSlotsLoading(true);
        getNewMeetingSlots({ sponsorId, delegateId: d.salesforceId, eventCode })
            .then((opts) => {
                setSlotOptions(opts);
                if (opts.length > 0) setSelectedKey(slotKey(opts[0]));
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
                    slotIdA: opt.slotIdA,
                    slotIdB: opt.slotIdB,
                    day: opt.day,
                    startTime: opt.startTime,
                    endTime: opt.endTime,
                    location: location || null,
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
        <div
            style={{
                position: "fixed",
                inset: 0,
                zIndex: 50,
                background: "rgba(0,0,0,0.45)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "16px",
            }}
        >
            <div
                style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r-lg)",
                    padding: "28px 32px",
                    width: "100%",
                    maxWidth: "500px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "16px",
                }}
            >
                <div
                    style={{
                        fontFamily: "var(--display)",
                        fontSize: "16px",
                        fontWeight: 700,
                    }}
                >
                    Create Meeting
                </div>

                {/* Warning if sponsor has reached or exceeded their meeting target. */}
                {scheduledCount >= meetingTarget && (
                    <div
                        style={{
                            fontSize: "12px",
                            padding: "8px 12px",
                            borderRadius: "var(--r)",
                            background: scheduledCount > meetingTarget
                                ? "rgba(232,57,30,0.08)"
                                : "rgba(240,160,32,0.1)",
                            color: scheduledCount > meetingTarget
                                ? "var(--red)"
                                : "var(--gold)",
                            border: `1px solid ${scheduledCount > meetingTarget
                                ? "rgba(232,57,30,0.25)"
                                : "rgba(240,160,32,0.3)"}`,
                        }}
                    >
                        {scheduledCount > meetingTarget
                            ? `This sponsor is over target (${scheduledCount} of ${meetingTarget} scheduled).`
                            : `This sponsor has reached their meeting target (${scheduledCount} of ${meetingTarget}).`}
                    </div>
                )}

                {/* Delegate picker */}
                <div>
                    <div className="adm-field-label" style={{ marginBottom: "6px" }}>
                        {selected ? (
                            <span>
                                Delegate:{" "}
                                <strong style={{ color: "var(--text)" }}>
                                    {selected.name}
                                    {selected.company ? ` · ${selected.company}` : ""}
                                </strong>{" "}
                                <button
                                    type="button"
                                    style={{
                                        background: "none",
                                        border: "none",
                                        color: "var(--blue)",
                                        cursor: "pointer",
                                        fontSize: "11px",
                                        padding: 0,
                                    }}
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
                                className="adm-input"
                                placeholder="Search by name or company…"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                style={{ marginBottom: "6px" }}
                            />
                            {loadError ? (
                                <div style={{ fontSize: "12px", color: "var(--red, #e8391e)" }}>{loadError}</div>
                            ) : delegates === null ? (
                                <div style={{ fontSize: "12px", color: "var(--t3)" }}>Loading…</div>
                            ) : (
                                <div
                                    style={{
                                        border: "1px solid var(--border)",
                                        borderRadius: "var(--r)",
                                        maxHeight: "180px",
                                        overflowY: "auto",
                                    }}
                                >
                                    {filtered.length === 0 ? (
                                        <div style={{ padding: "12px", fontSize: "12px", color: "var(--t3)", textAlign: "center" }}>
                                            No delegates found.
                                        </div>
                                    ) : (
                                        filtered.map((d) => (
                                            <button
                                                key={d.salesforceId}
                                                type="button"
                                                onClick={() => selectDelegate(d)}
                                                style={{
                                                    display: "block",
                                                    width: "100%",
                                                    textAlign: "left",
                                                    background: "none",
                                                    border: "none",
                                                    borderBottom: "1px solid var(--border)",
                                                    padding: "8px 12px",
                                                    cursor: "pointer",
                                                    fontSize: "13px",
                                                }}
                                            >
                                                <span style={{ color: "var(--text)" }}>{d.name}</span>
                                                {d.company && (
                                                    <span style={{ marginLeft: "6px", fontSize: "11px", color: "var(--t2)" }}>
                                                        {d.company}
                                                    </span>
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
                        <label className="adm-field" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                            <span className="adm-field-label">Time Slot</span>
                            {slotsLoading ? (
                                <span style={{ fontSize: "12px", color: "var(--t3)" }}>Loading slots…</span>
                            ) : slotOptions && slotOptions.length === 0 ? (
                                <span style={{ fontSize: "12px", color: "var(--gold)" }}>
                                    No mutual available slots for this pair.
                                </span>
                            ) : (
                                <select
                                    className="adm-input adm-select"
                                    style={{ width: "100%" }}
                                    value={selectedKey}
                                    onChange={(e) => setSelectedKey(e.target.value)}
                                    disabled={isPending || !slotOptions}
                                >
                                    {(slotOptions ?? []).map((o) => (
                                        <option key={`${o.slotIdA}|${o.slotIdB}`} value={`${o.slotIdA}|${o.slotIdB}`}>
                                            Day {o.day} – {fmtTime(o.startTime)}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </label>

                        <label className="adm-field" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                            <span className="adm-field-label">Location</span>
                            <input
                                type="text"
                                className="adm-input"
                                style={{ width: "100%" }}
                                placeholder="e.g. Table 3A"
                                value={location}
                                onChange={(e) => setLocation(e.target.value)}
                                disabled={isPending}
                            />
                        </label>
                    </>
                )}

                {saveError && (
                    <div
                        style={{
                            padding: "10px 14px",
                            background: "rgba(232,57,30,0.08)",
                            border: "1px solid var(--red-b, rgba(232,57,30,0.3))",
                            borderRadius: "var(--r)",
                            fontSize: "12px",
                            color: "var(--red, #e8391e)",
                        }}
                    >
                        {saveError}
                    </div>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
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

// MatchKindChip is a small badge that indicates the kind of match for a meeting (mutual, sponsor choice, delegate choice, or admin created).
function MatchKindChip({ kind }: { kind: MeetingMatchKind }) {
    // Define styles for each match kind.
    const styles: Record<MeetingMatchKind, { bg: string; color: string; border: string; label: string }> = {
        mutual:          { bg: "var(--green-s)",               color: "var(--green)",  border: "var(--green-b)",                   label: "Mutual" },
        sponsor_choice:  { bg: "var(--blue-s)",                color: "var(--blue)",   border: "var(--blue-b)",                    label: "Sponsor choice" },
        delegate_choice: { bg: "rgba(155,114,245,0.1)",        color: "var(--purple)", border: "rgba(155,114,245,0.25)",           label: "Delegate choice" },
        admin:           { bg: "rgba(240,160,32,0.1)",         color: "var(--gold)",   border: "rgba(240,160,32,0.3)",            label: "Admin created" },
    };

    // Get the styles for the current match kind.
    const s = styles[kind];

    // Render the chip with appropriate styles and label.
    return (
        <span
            style={{
                fontSize: "10px",
                padding: "2px 7px",
                borderRadius: "100px",
                fontWeight: 500,
                background: s.bg,
                color: s.color,
                border: `1px solid ${s.border}`,
                whiteSpace: "nowrap",
            }}
        >
            {s.label}
        </span>
    );
}

// SyncChip is a small badge that indicates the sync status of a meeting.
function SyncChip({ status }: { status: SyncStatus }) {
    // Define styles for each sync status.
    const styles: Record<SyncStatus, { bg: string; color: string; border: string; label: string }> = {
        synced:     { bg: "var(--green-s)", color: "var(--green)", border: "var(--green-b)", label: "Synced" },
        modified:   { bg: "rgba(240,160,32,0.1)", color: "var(--gold)", border: "rgba(240,160,32,0.3)", label: "Modified" },
        not_pushed: { bg: "var(--s3)", color: "var(--t2)", border: "var(--border)", label: "Not pushed" },
    };

    // Get the styles for the current sync status.
    const s = styles[status];

    // Render the chip with appropriate styles and label.
    return (
        <span
            style={{
                fontSize: "10px",
                padding: "2px 7px",
                borderRadius: "100px",
                fontWeight: 500,
                background: s.bg,
                color: s.color,
                border: `1px solid ${s.border}`,
                whiteSpace: "nowrap",
            }}
        >
            {s.label}
        </span>
    );
}

// SourceChip is a small badge that indicates whether a meeting was created from the portal or from Cvent.
function SourceChip({ source }: { source: MeetingSource }) {
    // Determine if the source is from the portal.
    const isPortal = source === "portal";

    // Render the chip with appropriate styles and label based on the source.
    return (
        <span
            style={{
                fontSize: "10px",
                padding: "2px 7px",
                borderRadius: "100px",
                background: isPortal ? "var(--blue-s)" : "var(--s3)",
                color: isPortal ? "var(--blue)" : "var(--t3)",
                border: `1px solid ${isPortal ? "var(--blue-b)" : "var(--border)"}`,
                whiteSpace: "nowrap",
            }}
        >
            {isPortal ? "Portal" : "Cvent"}
        </span>
    );
}

// StatChip is a small badge that displays a sponsor meeting statistic with a label and value.
function StatChip({
    label,
    value,
    valueColor,
}: {
    label: string;
    value: string;
    valueColor?: string;
}) {
    return (
        <div
            style={{
                background: "var(--s2)",
                border: "1px solid var(--border)",
                borderRadius: "var(--r)",
                padding: "8px 14px",
                display: "flex",
                flexDirection: "column",
                gap: "1px",
            }}
        >
            <span
                style={{
                    fontSize: "10px",
                    textTransform: "uppercase",
                    letterSpacing: ".07em",
                    color: "var(--t3)",
                }}
            >
                {label}
            </span>
            <span
                style={{
                    fontFamily: "var(--mono)",
                    fontSize: "15px",
                    fontWeight: 500,
                    color: valueColor ?? "var(--text)",
                }}
            >
                {value}
            </span>
        </div>
    );
}

// LegendItem is a small display component that shows a colored swatch and a label, used for legends in the UI.
function LegendItem({
    swatch,
    label,
}: {
    swatch: React.CSSProperties;
    label: string;
}) {
    return (
        <span style={{ display: "flex", alignItems: "center", gap: "5px" }}>
            <span style={{ display: "inline-block", flexShrink: 0, ...swatch }} />
            {label}
        </span>
    );
}
