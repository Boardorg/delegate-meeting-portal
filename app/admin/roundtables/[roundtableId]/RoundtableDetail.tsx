"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fmtTime, fmtWeekday } from "@/lib/format";
import { StatChip } from "../../meetings/_components/StatChip";
import { ConfirmModal } from "../../meetings/_components/ConfirmModal";
import {
    moveDelegate,
    saveRoundtableText,
    swapAlternate,
    type MoveResult,
    type MoveTarget,
    type RoundtableDetail,
    type SeatRow,
} from "./actions";

// ---------------------------------------------------------------------------
// RoundtableDetail: one roundtable, for /admin/roundtables/[roundtableId].
//
// Mirrors MeetingDetail on a sponsor's page.
// Admins type the theme title and discussion prompt, and move delegates between tables,
// alternates and the unassigned list. A move that breaks a rule is refused with a message.
// A move with warnings shows them and only saves once the admin confirms.
// Pushing roundtables to Cvent comes next, so there are no Push buttons yet.
// ---------------------------------------------------------------------------

/** A move waiting for the admin to confirm its warnings. */
type PendingMove = { warnings: string[]; retry: () => Promise<MoveResult> };

/**
 * Renders a roundtable with its theme, seats, alternates and the unassigned delegates.
 *
 * @param {{ detail: RoundtableDetail; eventCode: string }} props - The page data and the event.
 * @returns {JSX.Element} The page body.
 */
export default function RoundtableDetailView({ detail, eventCode }: { detail: RoundtableDetail; eventCode: string }) {
    const router = useRouter();
    const { table } = detail;
    const [theme, setTheme] = useState(table.themeTitle);
    const [prompt, setPrompt] = useState(table.description);
    const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
    const [pending, setPending] = useState<PendingMove | null>(null);
    const [isPending, startTransition] = useTransition();

    /**
     * Runs a move. A refusal shows its message, and warnings open a confirmation.
     *
     * @param {(confirmed: boolean) => Promise<MoveResult>} call - The move, with or without confirmation.
     */
    function runMove(call: (confirmed: boolean) => Promise<MoveResult>) {
        startTransition(async () => {
            setMessage(null);
            const result = await call(false);
            if (result.ok) {
                router.refresh();
                return;
            }
            if ("needsConfirm" in result) {
                setPending({ warnings: result.warnings, retry: () => call(true) });
                return;
            }
            setMessage({ tone: "error", text: result.error });
        });
    }

    /** Saves the move the admin confirmed despite its warnings. */
    function confirmPending() {
        if (!pending) return;
        startTransition(async () => {
            const result = await pending.retry();
            setPending(null);
            if (!result.ok) setMessage({ tone: "error", text: "error" in result ? result.error : "Not saved." });
            router.refresh();
        });
    }

    /**
     * Moves a delegate to a target.
     *
     * @param {string} delegateId - The delegate.
     * @param {MoveTarget} to - Where to, or null to unassign.
     */
    function move(delegateId: string, to: MoveTarget) {
        runMove((confirmed) => moveDelegate({ eventCode, delegateId, to, confirmed }));
    }

    /**
     * Swaps an alternate into a seated delegate's seat.
     *
     * @param {string} alternateId - The alternate.
     * @param {string} seatedId - The seated delegate.
     */
    function swap(alternateId: string, seatedId: string) {
        runMove((confirmed) =>
            swapAlternate({ eventCode, roundtableId: table.id, alternateId, seatedId, confirmed }),
        );
    }

    /** Saves the theme title and discussion prompt. */
    function saveText() {
        startTransition(async () => {
            const result = await saveRoundtableText({ roundtableId: table.id, themeTitle: theme, description: prompt });
            setMessage(result.ok ? { tone: "ok", text: "Saved." } : { tone: "error", text: result.error });
            if (result.ok) router.refresh();
        });
    }

    return (
        <div className="adm-page">
            <nav className="adm-breadcrumb">
                <Link href="/admin/roundtables">Roundtables</Link>
                <span className="adm-breadcrumb-sep">›</span>
                <span>{table.location}</span>
            </nav>

            <div className="adm-card">
                <div className="adm-card-head">
                    <div>
                        <div className="adm-card-title">{table.themeTitle || table.location}</div>
                        <div className="adm-card-sub">
                            {table.location} · {fmtWeekday(table.startTime, detail.timezone)}{" "}
                            {fmtTime(table.startTime, detail.timezone)}
                        </div>
                        <div className="adm-card-sub">{table.summary}</div>
                    </div>
                </div>
                <div className="adm-card-row">
                    <StatChip
                        label="Seats filled"
                        value={`${detail.seated.length} / ${table.seats}`}
                        valueColor={table.short ? "var(--gold)" : undefined}
                    />
                    <StatChip label="Alternates" value={String(detail.alternates.length)} />
                    <StatChip
                        label="Average score"
                        value={String(table.averageScore)}
                        valueColor={table.weak ? "var(--gold)" : undefined}
                    />
                    {table.short && <StatChip label="Short" value="Yes" valueColor="var(--gold)" />}
                    {table.weak && <StatChip label="Weak match" value="Yes" valueColor="var(--gold)" />}
                </div>
            </div>

            <div className="adm-card">
                <div className="adm-card-title">Theme</div>
                <label className="adm-field adm-field-mb-lg">
                    <span className="adm-field-label">Theme Title</span>
                    <input
                        className="adm-input"
                        value={theme}
                        maxLength={200}
                        onChange={(e) => setTheme(e.target.value)}
                        placeholder="Shown as the appointment's title in Cvent"
                    />
                </label>
                <label className="adm-field adm-field-mb-lg">
                    <span className="adm-field-label">Discussion Prompt (optional)</span>
                    <textarea
                        className="adm-input"
                        rows={3}
                        value={prompt}
                        maxLength={2000}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder="Shown as the appointment's message in Cvent"
                    />
                </label>
                <div className="adm-card-row">
                    <button
                        type="button"
                        className="adm-new-btn adm-new-btn-primary"
                        disabled={isPending || (theme === table.themeTitle && prompt === table.description)}
                        onClick={saveText}
                    >
                        {isPending ? "Saving…" : "Save Theme"}
                    </button>
                    <span className="adm-help-note">Pushing roundtables to Cvent comes next.</span>
                </div>
            </div>

            {message && (
                <div className={message.tone === "error" ? "adm-modal-error" : "adm-help-note"}>{message.text}</div>
            )}

            <div className="adm-chart-title">Seated ({detail.seated.length})</div>
            <SeatTable
                rows={detail.seated}
                empty="No one is seated yet."
                actions={(r) => (
                    <MoveSelect
                        detail={detail}
                        current={{ roundtableId: table.id, role: "seated" }}
                        disabled={isPending}
                        onMove={(to) => move(r.delegateId, to)}
                    />
                )}
            />

            <div className="adm-chart-title" style={{ marginTop: 24 }}>
                Alternates ({detail.alternates.length})
            </div>
            <p className="adm-help-note">Alternates are listed here only and are never sent to Cvent.</p>
            <SeatTable
                rows={detail.alternates}
                empty="No alternates."
                actions={(r) => (
                    <>
                        <select
                            className="adm-input adm-select"
                            value=""
                            disabled={isPending || detail.seated.length === 0}
                            onChange={(e) => e.target.value && swap(r.delegateId, e.target.value)}
                        >
                            <option value="">Swap in for…</option>
                            {detail.seated.map((s) => (
                                <option key={s.delegateId} value={s.delegateId}>
                                    {s.name}
                                </option>
                            ))}
                        </select>{" "}
                        <MoveSelect
                            detail={detail}
                            current={{ roundtableId: table.id, role: "alternate" }}
                            disabled={isPending}
                            onMove={(to) => move(r.delegateId, to)}
                        />
                    </>
                )}
            />

            <div className="adm-chart-title" style={{ marginTop: 24 }}>
                Unassigned ({detail.unassigned.length})
            </div>
            <p className="adm-help-note">Delegates with no meetings who have no seat anywhere, best fit with this table first.</p>
            {detail.unassigned.length === 0 ? (
                <div className="adm-empty">No one is unassigned.</div>
            ) : (
                <table className="adm-table">
                    <thead>
                        <tr>
                            <th>Delegate</th>
                            <th>Company</th>
                            <th>What They Share With This Table</th>
                            <th className="adm-actions-col">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {detail.unassigned.map((u) => (
                            <tr key={u.delegateId} className="adm-row">
                                <td>
                                    <div className="adm-party-name">{u.name}</div>
                                </td>
                                <td>{u.company || "—"}</td>
                                <td>
                                    <span className="adm-text-sm-muted">
                                        {u.reason}
                                        <span className="adm-mono-dim"> · {u.score}</span>
                                    </span>
                                </td>
                                <td className="adm-actions-cell">
                                    <div className="adm-actions-inner">
                                        <button
                                            type="button"
                                            className="adm-btn adm-btn-primary"
                                            disabled={isPending}
                                            onClick={() => move(u.delegateId, { roundtableId: table.id, role: "seated" })}
                                        >
                                            Seat Here
                                        </button>
                                        <button
                                            type="button"
                                            className="adm-btn"
                                            disabled={isPending}
                                            onClick={() => move(u.delegateId, { roundtableId: table.id, role: "alternate" })}
                                        >
                                            Add as Alternate
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {pending && (
                <ConfirmModal
                    title="Save This Move?"
                    confirmLabel="Save Anyway"
                    pendingLabel="Saving…"
                    isPending={isPending}
                    error={null}
                    onConfirm={confirmPending}
                    onCancel={() => setPending(null)}
                >
                    <ul className="adm-modal-body">
                        {pending.warnings.map((w) => (
                            <li key={w}>{w}</li>
                        ))}
                    </ul>
                </ConfirmModal>
            )}
        </div>
    );
}

/**
 * A table of seated delegates or alternates.
 *
 * @param {{ rows: SeatRow[]; empty: string; actions: (row: SeatRow) => React.ReactNode }} props - The rows, the empty text and each row's actions.
 * @returns {JSX.Element} The table.
 */
function SeatTable({
    rows,
    empty,
    actions,
}: {
    rows: SeatRow[];
    empty: string;
    actions: (row: SeatRow) => React.ReactNode;
}) {
    if (rows.length === 0) return <div className="adm-empty">{empty}</div>;
    return (
        <table className="adm-table">
            <thead>
                <tr>
                    <th>Delegate</th>
                    <th>Company</th>
                    <th>What They Share</th>
                    <th className="adm-actions-col">Actions</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((r) => (
                    <tr key={r.delegateId} className="adm-row">
                        <td>
                            <div className="adm-party-name">{r.name}</div>
                            {r.title && <div className="adm-text-sm-muted">{r.title}</div>}
                        </td>
                        <td>{r.company || "—"}</td>
                        <td>
                            <span className="adm-text-sm-muted">
                                {r.reason}
                                <span className="adm-mono-dim"> · {r.score}</span>
                            </span>
                        </td>
                        <td className="adm-actions-cell">
                            <div className="adm-actions-inner">{actions(r)}</div>
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

/**
 * The "Move to…" menu: a seat or alternate at any table, or the unassigned list.
 * The delegate's current place is left out.
 *
 * @param {{ detail: RoundtableDetail; current: { roundtableId: string; role: "seated" | "alternate" }; disabled: boolean; onMove: (to: MoveTarget) => void }} props
 * @returns {JSX.Element} The menu.
 */
function MoveSelect({
    detail,
    current,
    disabled,
    onMove,
}: {
    detail: RoundtableDetail;
    current: { roundtableId: string; role: "seated" | "alternate" };
    disabled: boolean;
    onMove: (to: MoveTarget) => void;
}) {
    const choices = detail.tables.flatMap((t) =>
        (["seated", "alternate"] as const)
            .filter((role) => !(t.id === current.roundtableId && role === current.role))
            .map((role) => ({
                value: `${t.id}|${role}`,
                label: `${role === "seated" ? "Seat at" : "Alternate at"} ${t.label}${t.id === current.roundtableId ? " (this table)" : ""}`,
            })),
    );
    return (
        <select
            className="adm-input adm-select"
            value=""
            disabled={disabled}
            onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                if (v === "unassign") {
                    onMove(null);
                    return;
                }
                const [roundtableId, role] = v.split("|");
                onMove({ roundtableId, role: role as "seated" | "alternate" });
            }}
        >
            <option value="">Move to…</option>
            {choices.map((c) => (
                <option key={c.value} value={c.value}>
                    {c.label}
                </option>
            ))}
            <option value="unassign">Unassigned</option>
        </select>
    );
}
