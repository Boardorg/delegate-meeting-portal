"use client";

import type { RoundtableReport } from "@/lib/matching/roundtableReport";
import { fmtTime, fmtWeekday } from "@/lib/format";
import { StatChip } from "../meetings/_components/StatChip";

// ---------------------------------------------------------------------------
// RoundtableReportPanel — the summary shown after "Run Roundtable Grouping".
//
// Mirrors SchedulerReportPanel on the sponsor page: headline counts, each table with its
// short or weak flags and what it shares, then the unassigned delegates.
// ---------------------------------------------------------------------------

const GREEN = "#7fa0b8";
const RED = "#b92025";

/**
 * Renders a roundtable run report.
 *
 * @param {{ report: RoundtableReport; timezone: string; onDismiss: () => void }} props - The report, the event's timezone and the dismiss handler.
 * @returns {JSX.Element} The panel.
 */
export default function RoundtableReportPanel({
    report,
    timezone,
    onDismiss,
}: {
    report: RoundtableReport;
    timezone: string;
    onDismiss: () => void;
}) {
    const seated = report.tables.reduce((sum, t) => sum + t.seated, 0);
    const flagged = report.tables.filter((t) => t.short || t.weak).length;
    return (
        <div className="adm-card">
            <div className="adm-card-head">
                <div>
                    <div className="adm-card-title">Roundtable Grouping Results</div>
                    <div className="adm-card-sub">
                        {report.eventCode} · generated {new Date(report.generatedAt).toLocaleString()}
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
                <StatChip label="Tables" value={String(report.tables.length)} />
                <StatChip label="Eligible delegates" value={String(report.eligible)} />
                <StatChip label="Seated" value={String(seated)} valueColor={GREEN} />
                <StatChip label="Short or weak tables" value={String(flagged)} valueColor={flagged > 0 ? "var(--gold)" : undefined} />
                <StatChip
                    label="Unassigned"
                    value={String(report.unassigned.length)}
                    valueColor={report.unassigned.length > 0 ? RED : undefined}
                />
                {report.kept > 0 && <StatChip label="Pushed tables kept" value={String(report.kept)} />}
            </div>

            <p className="adm-help-note">
                Left out: {report.excluded.hasMeetings} with meetings, {report.excluded.conferenceOnly} conference-only
                and {report.excluded.cancelled} cancelled in Cvent.
            </p>

            <div style={{ marginTop: 20 }}>
                <div className="adm-chart-title">Tables ({report.tables.length})</div>
                <ul className="adm-sync-list">
                    {report.tables.map((t) => (
                        <li
                            key={`${t.label}|${t.startTime}`}
                            className={`adm-sync-item${t.short || t.weak ? " adm-sync-item-warn" : ""}`}
                        >
                            <div className="adm-party-name">
                                {t.label} · {fmtWeekday(t.startTime, timezone)} {fmtTime(t.startTime, timezone)} · {t.seated} / {t.seats} seated
                                {t.short && " · short"}
                                {t.weak && " · weak match"}
                            </div>
                            <div className="adm-sync-detail">{t.summary}</div>
                        </li>
                    ))}
                </ul>
            </div>

            <div style={{ marginTop: 20 }}>
                <div className="adm-chart-title">Unassigned Delegates ({report.unassigned.length})</div>
                {report.unassigned.length === 0 ? (
                    <div className="adm-empty">Every eligible delegate has a seat or is an alternate.</div>
                ) : (
                    <ul className="adm-sync-list">
                        {report.unassigned.map((u) => (
                            <li key={`${u.name}|${u.company}`} className="adm-sync-item">
                                <div className="adm-party-name">{u.name}</div>
                                <div className="adm-sync-detail">{u.company || "—"}</div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
