"use client";

import type { D2DReport } from "@/lib/matching/d2dReport";
import { D2D_UNMATCHED_LABEL } from "@/lib/matching/d2dReport";
import { StatChip } from "../meetings/_components/StatChip";

// ---------------------------------------------------------------------------
// D2DReportPanel: the summary shown after "Run D2D Matching".
//
// Mirrors SchedulerReportPanel on the sponsor page: headline counts, then the weak matches
// and the unmatched delegates. Pure presentation over the serializable D2DReport.
// ---------------------------------------------------------------------------

const GREEN = "#7fa0b8";
const RED = "#b92025";

/**
 * Renders a D2D run report.
 *
 * @param {{ report: D2DReport; onDismiss: () => void }} props - The report and the dismiss handler.
 * @returns {JSX.Element} The panel.
 */
export default function D2DReportPanel({
    report,
    onDismiss,
}: {
    report: D2DReport;
    onDismiss: () => void;
}) {
    const excluded = report.excluded;
    return (
        <div className="adm-card">
            <div className="adm-card-head">
                <div>
                    <div className="adm-card-title">D2D Matching Results</div>
                    <div className="adm-card-sub">
                        {report.eventCode} · generated{" "}
                        {new Date(report.generatedAt).toLocaleString()}
                    </div>
                </div>
                <button className="adm-link-btn" onClick={onDismiss}>
                    Dismiss
                </button>
            </div>

            {report.warnings.map((w) => (
                <div key={w} className="adm-modal-warn-at" style={{ marginTop: 12, marginBottom: 16 }}>
                    {w}
                </div>
            ))}

            <div className="adm-card-row">
                <StatChip label="Eligible delegates" value={String(report.eligible)} />
                <StatChip label="Meetings created" value={String(report.created)} valueColor={GREEN} />
                <StatChip label="Delegates matched" value={String(report.matchedDelegates)} valueColor={GREEN} />
                <StatChip label="Pushed meetings kept" value={String(report.kept)} />
                <StatChip
                    label="Weak matches"
                    value={String(report.weak.length)}
                    valueColor={report.weak.length > 0 ? "var(--gold)" : undefined}
                />
                <StatChip
                    label="Unmatched"
                    value={String(report.unmatched.length)}
                    valueColor={report.unmatched.length > 0 ? RED : undefined}
                />
            </div>

            <p className="adm-help-note">
                Left out: {excluded.incompleteProfile} without a completed Networking Profile,{" "}
                {excluded.conferenceOnly} conference-only, {excluded.seatedAtRoundtable} seated at a roundtable and{" "}
                {excluded.cancelled} cancelled in Cvent.
            </p>

            <div style={{ marginTop: 20 }}>
                <div className="adm-chart-title">Weak Matches ({report.weak.length})</div>
                {report.weak.length === 0 ? (
                    <div className="adm-empty">Every new pair met the minimum score.</div>
                ) : (
                    <ul className="adm-sync-list">
                        {report.weak.map((w) => (
                            <li key={w.label} className="adm-sync-item adm-sync-item-warn">
                                <div className="adm-party-name">
                                    {w.label} · score {w.score}
                                </div>
                                <div className="adm-sync-detail">{w.explanation}</div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div style={{ marginTop: 20 }}>
                <div className="adm-chart-title">Unmatched Delegates ({report.unmatched.length})</div>
                {report.unmatched.length === 0 ? (
                    <div className="adm-empty">Every eligible delegate with room got a meeting.</div>
                ) : (
                    <table className="adm-table">
                        <thead>
                            <tr>
                                <th>Delegate</th>
                                <th>Company</th>
                                <th>Reason</th>
                            </tr>
                        </thead>
                        <tbody>
                            {report.unmatched.map((u) => (
                                <tr key={`${u.name}|${u.company}`} className="adm-row">
                                    <td>
                                        <div className="adm-party-name">{u.name}</div>
                                    </td>
                                    <td>{u.company || "—"}</td>
                                    <td>{D2D_UNMATCHED_LABEL[u.reason]}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
