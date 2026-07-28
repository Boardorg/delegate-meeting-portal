"use client";

import type { MaintenanceReport } from "./actions";

// ---------------------------------------------------------------------------
// MaintenanceReportPanel — post-action summary for the bulk maintenance
// buttons (clear un-synced / unpush synced), shown above the meetings table.
//
// Mirrors SyncReportPanel: headline StatChips plus, for unpush, any per-meeting
// failures. Pure presentation over the serializable MaintenanceReport.
// ---------------------------------------------------------------------------

const GREEN = "#2ec97e";
const RED = "#e8391e";

export default function MaintenanceReportPanel({
    report,
    onDismiss,
}: {
    report: MaintenanceReport;
    onDismiss: () => void;
}) {
    const title =
        report.kind === "clear_unsynced"
            ? "Cleared Un-synced Meetings"
            : "Unpushed Synced Meetings";

    return (
        <div className="adm-card">
            <div className="adm-card-head">
                <div>
                    <div className="adm-card-title">{title}</div>
                    <div className="adm-card-sub">
                        {report.eventCode} · generated{" "}
                        {new Date(report.generatedAt).toLocaleString()}
                    </div>
                </div>
                <button className="adm-link-btn" onClick={onDismiss}>
                    Dismiss
                </button>
            </div>

            {report.kind === "clear_unsynced" ? (
                <>
                    <div className="adm-card-row">
                        <StatChip
                            label="Deleted"
                            value={String(report.deleted)}
                            valueColor={report.deleted > 0 ? GREEN : undefined}
                        />
                    </div>
                    {report.deleted === 0 && (
                        <p className="adm-help-note">
                            Nothing to clear — this event has no un-synced
                            meetings in the database.
                        </p>
                    )}
                </>
            ) : (
                <>
                    <div className="adm-card-row">
                        <StatChip
                            label="Synced meetings"
                            value={String(report.total)}
                        />
                        <StatChip
                            label="Unpushed"
                            value={String(report.unpushed)}
                            valueColor={report.unpushed > 0 ? GREEN : undefined}
                        />
                        <StatChip
                            label="Already gone"
                            value={String(report.alreadyGone)}
                        />
                        <StatChip
                            label="Failed"
                            value={String(report.failed)}
                            valueColor={report.failed > 0 ? RED : undefined}
                        />
                    </div>

                    {report.total === 0 && (
                        <p className="adm-help-note">
                            Nothing to unpush — this event has no synced
                            meetings in Cvent.
                        </p>
                    )}

                    {report.notes.length > 0 && (
                        <div style={{ marginTop: 20 }}>
                            <div className="adm-chart-title">
                                Already gone in Cvent ({report.notes.length})
                            </div>
                            <ul className="adm-sync-list">
                                {report.notes.map((n) => (
                                    <li
                                        key={n.meetingId}
                                        className="adm-sync-item adm-sync-item-warn"
                                    >
                                        <div className="adm-party-name">
                                            {n.label}
                                        </div>
                                        <div className="adm-sync-detail">
                                            {n.detail}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {report.failures.length > 0 && (
                        <div style={{ marginTop: 20 }}>
                            <div className="adm-chart-title">
                                Failed to unpush ({report.failures.length})
                            </div>
                            <ul className="adm-sync-list">
                                {report.failures.map((f) => (
                                    <li
                                        key={f.meetingId}
                                        className="adm-sync-item"
                                    >
                                        <div className="adm-party-name">
                                            {f.label}
                                        </div>
                                        <div className="adm-sync-detail">
                                            {f.detail}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

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
        <div className="adm-stat-chip">
            <span className="adm-stat-label">{label}</span>
            <span
                className="adm-stat-value"
                style={valueColor ? { color: valueColor } : undefined}
            >
                {value}
            </span>
        </div>
    );
}
