"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fmtTime, fmtWeekday } from "@/lib/format";
import type { RoundtableReport } from "@/lib/matching/roundtableReport";
import { ConfirmModal } from "../meetings/_components/ConfirmModal";
import { ProgressCell } from "../meetings/_components/ProgressCell";
import MaintenanceReportPanel from "../meetings/MaintenanceReportPanel";
import type { MaintenanceReport } from "../meetings/actions";
import RoundtableReportPanel from "./RoundtableReportPanel";
import {
    clearUnsyncedRoundtablesForEvent,
    runRoundtablesForEvent,
    type RoundtablesOverview,
} from "./actions";

// ---------------------------------------------------------------------------
// RoundtablesTable: the roundtable list for /admin/roundtables.
//
// Mirrors SponsorsTable on the Sponsor Meetings page: the same header buttons and confirmations
// and the same report panels. Clicking a table opens it.
// Pushing roundtables to Cvent comes next, so Push All and Unpush All are shown disabled.
// ---------------------------------------------------------------------------

type Props = {
    selectedEvent: string | null;
    data: RoundtablesOverview;
    /** The event's IANA timezone, for table times. */
    timezone: string;
};

/** The note on the disabled push buttons. */
const PUSH_LATER_NOTE = "Pushing roundtables to Cvent comes next.";

/**
 * Renders the Roundtables list, its header buttons, the unassigned list and the tables found in Cvent.
 *
 * @param {Props} props - The event, the list data and the timezone.
 * @returns {JSX.Element} The page body.
 */
export default function RoundtablesTable({ selectedEvent, data, timezone }: Props) {
    const router = useRouter();
    const [openModal, setOpenModal] = useState<"run" | "clear" | null>(null);
    const [modalError, setModalError] = useState<string | null>(null);
    const [report, setReport] = useState<RoundtableReport | null>(null);
    const [maintenanceReport, setMaintenanceReport] = useState<MaintenanceReport | null>(null);
    const [isPending, startTransition] = useTransition();

    /** Runs roundtable grouping. A stopped run keeps the confirmation open with its message. */
    function handleRun() {
        if (!selectedEvent) return;
        startTransition(async () => {
            try {
                setModalError(null);
                const result = await runRoundtablesForEvent(selectedEvent);
                if (!result.ok) {
                    setModalError(result.error);
                    return;
                }
                setReport(result.report);
                setOpenModal(null);
                router.refresh();
            } catch (e) {
                setModalError(e instanceof Error ? e.message : "An unexpected error occurred.");
            }
        });
    }

    /** Deletes every roundtable not pushed to Cvent. */
    function handleClear() {
        if (!selectedEvent) return;
        startTransition(async () => {
            try {
                setModalError(null);
                setMaintenanceReport(await clearUnsyncedRoundtablesForEvent(selectedEvent));
                setOpenModal(null);
                router.refresh();
            } catch (e) {
                setModalError(e instanceof Error ? e.message : "An unexpected error occurred.");
            }
        });
    }

    const missing = data.cventTables.filter((t) => !t.hasRoundtable).length;

    return (
        <div className="adm-page">
            <div className="adm-page-head">
                <h1 className="adm-page-title">Roundtables</h1>
            </div>

            <div className="adm-toolbar">
                <button
                    className="adm-new-btn adm-new-btn-primary"
                    disabled={!selectedEvent || isPending}
                    onClick={() => {
                        setModalError(null);
                        setOpenModal("run");
                    }}
                >
                    {isPending ? "Running…" : "Run Roundtable Grouping"}
                </button>
                <button className="adm-new-btn adm-new-btn-primary" disabled title={PUSH_LATER_NOTE}>
                    Push All to Cvent
                </button>
                <button
                    className="adm-new-btn adm-new-btn-danger"
                    disabled={!selectedEvent || isPending}
                    onClick={() => {
                        setModalError(null);
                        setOpenModal("clear");
                    }}
                >
                    {isPending ? "Working…" : "Clear All Unsynced"}
                </button>
                <button className="adm-new-btn adm-new-btn-danger-solid" disabled title={PUSH_LATER_NOTE}>
                    Unpush All Synced
                </button>
            </div>
            <p className="adm-help-note">{PUSH_LATER_NOTE}</p>

            {openModal === "run" && selectedEvent && (
                <ConfirmModal
                    title="Run Roundtable Grouping?"
                    confirmLabel="Run Grouping"
                    pendingLabel="Running…"
                    isPending={isPending}
                    error={modalError}
                    onConfirm={handleRun}
                    onCancel={() => setOpenModal(null)}
                >
                    <p className="adm-modal-body">
                        This will replace every roundtable for <strong>{selectedEvent}</strong> that hasn&apos;t
                        been pushed to Cvent, including its seats, alternates, theme title and discussion prompt.
                        Only delegates with no meetings are grouped.
                    </p>
                    {data.orderWarning && (
                        <div className="adm-modal-warn-at" role="alert" style={{ marginBottom: 16 }}>
                            {data.orderWarning}
                        </div>
                    )}
                </ConfirmModal>
            )}

            {openModal === "clear" && selectedEvent && (
                <ConfirmModal
                    title="Clear All Unsynced Roundtables?"
                    confirmLabel="Clear Unsynced"
                    pendingLabel="Clearing…"
                    tone="danger"
                    isPending={isPending}
                    error={modalError}
                    onConfirm={handleClear}
                    onCancel={() => setOpenModal(null)}
                >
                    <p className="adm-modal-body">
                        This permanently deletes every roundtable for <strong>{selectedEvent}</strong> that has not
                        been pushed to Cvent, with its seats, alternates and theme. This cannot be undone.
                    </p>
                </ConfirmModal>
            )}

            {report && <RoundtableReportPanel report={report} timezone={timezone} onDismiss={() => setReport(null)} />}
            {maintenanceReport && (
                <MaintenanceReportPanel report={maintenanceReport} onDismiss={() => setMaintenanceReport(null)} />
            )}

            {missing > 0 && data.rows.length > 0 && (
                <div className="adm-modal-warn-at" role="alert" style={{ marginBottom: 16 }}>
                    {missing === 1
                        ? "1 Delegate Group slot in Cvent has no roundtable yet. Run the grouping again to add it."
                        : `${missing} Delegate Group slots in Cvent have no roundtable yet. Run the grouping again to add them.`}
                </div>
            )}

            <table className="adm-table">
                <thead>
                    <tr>
                        <th>Table</th>
                        <th>Day and Time</th>
                        <th>Theme Title</th>
                        <th>Seats</th>
                        <th>What They Share</th>
                    </tr>
                </thead>
                <tbody>
                    {data.rows.length === 0 ? (
                        <tr>
                            <td colSpan={5} className="adm-empty">
                                {!selectedEvent
                                    ? "No events found."
                                    : data.cventTables.length === 0
                                      ? "No Delegate Group slots were found in Cvent. Map the roundtable appointment type in Event Settings."
                                      : "No roundtables yet. Run the grouping to fill the tables."}
                            </td>
                        </tr>
                    ) : (
                        data.rows.map((r) => (
                            <tr
                                key={r.id}
                                className={`adm-row adm-row-clickable${r.short || r.weak ? " adm-row-conflict" : ""}`}
                                onClick={() => router.push(`/admin/roundtables/${encodeURIComponent(r.id)}`)}
                            >
                                <td>
                                    <div className="adm-party-name">{r.location}</div>
                                    <div className="adm-chip-mt">
                                        {r.short && <span className="adm-chip adm-chip-modified">Short</span>}{" "}
                                        {r.weak && <span className="adm-chip adm-chip-modified">Weak match</span>}
                                    </div>
                                </td>
                                <td>
                                    <span className="adm-text-sm-muted">
                                        {fmtWeekday(r.startTime, timezone)} {fmtTime(r.startTime, timezone)}
                                    </span>
                                </td>
                                <td>{r.themeTitle || <span className="adm-dim">No theme yet</span>}</td>
                                <td>
                                    <ProgressCell
                                        count={r.seated}
                                        total={r.seats}
                                        percent={r.seats > 0 ? Math.round((r.seated / r.seats) * 100) : 0}
                                    />
                                </td>
                                <td>
                                    <span className="adm-text-sm-muted">{r.summary}</span>
                                </td>
                            </tr>
                        ))
                    )}
                </tbody>
            </table>

            <div style={{ marginTop: 24 }}>
                <div className="adm-chart-title">Unassigned Delegates ({data.unassigned.length})</div>
                <p className="adm-help-note">
                    Delegates with no meetings who have no seat and aren&apos;t an alternate. Open a table to seat
                    one of them.
                </p>
                {data.unassigned.length === 0 ? (
                    <div className="adm-empty">No one is unassigned.</div>
                ) : (
                    <table className="adm-table">
                        <thead>
                            <tr>
                                <th>Delegate</th>
                                <th>Company</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.unassigned.map((u) => (
                                <tr key={u.delegateId} className="adm-row">
                                    <td>
                                        <div className="adm-party-name">{u.name}</div>
                                    </td>
                                    <td>{u.company || "—"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
