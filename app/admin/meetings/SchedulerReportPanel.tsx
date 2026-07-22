"use client";

import {
    Bar,
    BarChart,
    CartesianGrid,
    Legend,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import type {
    SchedulerFailureReason,
    SchedulerReport,
} from "@/lib/scheduling/report";

// ---------------------------------------------------------------------------
// SchedulerReportPanel — post-run summary shown above the meetings table.
//
// Renders the ephemeral SchedulerReport returned by runSchedulerForEvent:
// headline counts, a scheduled-vs-unscheduled bar chart by interest level,
// and a list of unscheduled requests with human-readable reasons. Pure
// presentation over a serializable report — no data fetching here.
// ---------------------------------------------------------------------------

// Chart series colors, matched to the admin theme tokens (--green / --red).
// recharts needs literal values, so the token hexes are inlined.
const GREEN = "#2ec97e";
const RED = "#e8391e";
// Muted chrome so the chart reads as "light theming" over the dark surface.
const AXIS = "#9a9eb0"; // --t2
const GRID = "#2a2d38"; // --border

// Friendly labels for the closed set of failure reasons.
const REASON_LABEL: Record<SchedulerFailureReason, string> = {
    cap_reached: "Cap reached",
    no_availability: "No availability",
    company_diversity: "Company diversity limit",
    self_request: "Self request",
    not_an_attendee: "Not in attendee list",
    already_scheduled: "Already meets in Cvent",
    no_pass_match: "No matching pass",
    conflict_existing: "Conflicts with pushed meeting",
};

export default function SchedulerReportPanel({
    report,
    onDismiss,
}: {
    report: SchedulerReport;
    onDismiss: () => void;
}) {
    // Chart rows: one bar group per interest level, green scheduled / red not.
    const chartData = report.byInterestLevel.map((b) => ({
        level: `Level ${b.level}`,
        Scheduled: b.scheduled,
        Unscheduled: b.unscheduled,
    }));

    // Show the pass-rules explainer only when at least one request matched no
    // pass, since that's the reason that needs the extra context.
    const hasNoPassMatch = report.unscheduledRequests.some(
        (u) => u.reason === "no_pass_match",
    );

    return (
        <div className="adm-card">
            <div className="adm-card-head">
                <div>
                    <div className="adm-card-title">Scheduling Results</div>
                    <div className="adm-card-sub">
                        {report.eventCode} · generated{" "}
                        {new Date(report.generatedAt).toLocaleString()}
                    </div>
                </div>
                <button className="adm-link-btn" onClick={onDismiss}>
                    Dismiss
                </button>
            </div>

            <div className="adm-card-row">
                <StatChip
                    label="Sponsors considered"
                    value={String(report.sponsorsConsidered)}
                />
                <StatChip
                    label="Requests considered"
                    value={String(report.requestsConsidered)}
                />
                <StatChip
                    label="Meetings scheduled"
                    value={String(report.meetingsScheduled)}
                    valueColor={GREEN}
                />
                <StatChip
                    label="Mutual meetings"
                    value={String(report.mutualMeetings)}
                />
                <StatChip
                    label="Unscheduled requests"
                    value={String(report.unscheduledRequests.length)}
                    valueColor={
                        report.unscheduledRequests.length > 0 ? RED : undefined
                    }
                />
            </div>

            <div style={{ marginTop: 20 }}>
                <div className="adm-chart-title">
                    Requests by interest level
                </div>
                <div style={{ width: "100%", height: 260 }}>
                    <ResponsiveContainer>
                        <BarChart
                            data={chartData}
                            margin={{ top: 8, right: 12, bottom: 4, left: -8 }}
                        >
                            <CartesianGrid
                                strokeDasharray="3 3"
                                stroke={GRID}
                                vertical={false}
                            />
                            <XAxis
                                dataKey="level"
                                stroke={AXIS}
                                tick={{ fill: AXIS, fontSize: 12 }}
                                tickLine={false}
                            />
                            <YAxis
                                allowDecimals={false}
                                stroke={AXIS}
                                tick={{ fill: AXIS, fontSize: 12 }}
                                tickLine={false}
                            />
                            <Tooltip
                                cursor={{ fill: "rgba(255,255,255,0.04)" }}
                                contentStyle={{
                                    background: "#13141a",
                                    border: `1px solid ${GRID}`,
                                    borderRadius: 8,
                                    fontSize: 12,
                                }}
                                labelStyle={{ color: "#edeef2" }}
                            />
                            <Legend wrapperStyle={{ fontSize: 12 }} />
                            <Bar
                                dataKey="Scheduled"
                                stackId="a"
                                fill={GREEN}
                                radius={[0, 0, 0, 0]}
                            />
                            <Bar
                                dataKey="Unscheduled"
                                stackId="a"
                                fill={RED}
                                radius={[3, 3, 0, 0]}
                            />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </div>

            <div style={{ marginTop: 20 }}>
                <div className="adm-chart-title">
                    Unscheduled requests ({report.unscheduledRequests.length})
                </div>
                {report.unscheduledRequests.length === 0 ? (
                    <div className="adm-empty">
                        Every request was scheduled.
                    </div>
                ) : (
                    <table className="adm-table">
                        <thead>
                            <tr>
                                <th>Requester</th>
                                <th>Target</th>
                                <th>Interest</th>
                                <th>Reason</th>
                            </tr>
                        </thead>
                        <tbody>
                            {report.unscheduledRequests.map((u) => (
                                <tr
                                    key={`${u.requesterId}|${u.targetId}`}
                                    className="adm-row"
                                >
                                    <td>
                                        <div className="adm-party-name">
                                            {u.requesterName}
                                        </div>
                                    </td>
                                    <td>
                                        <div className="adm-party-name">
                                            {u.targetName}
                                        </div>
                                    </td>
                                    <td className="adm-mono">{u.rank}</td>
                                    <td>{REASON_LABEL[u.reason]}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}

                {hasNoPassMatch && (
                    <p className="adm-help-note">
                        <strong>“No matching pass”</strong> means the request fit
                        none of the scheduling passes, so it was never
                        considered. Meetings are placed in priority order:
                        mutual sponsor–delegate pairs, high-interest (rank ≥ 4)
                        sponsor→delegate and delegate→sponsor requests, all
                        remaining sponsor→delegate requests, then mutual and
                        remaining delegate–delegate requests on day 2. Requests
                        outside these rules — most commonly a low-interest
                        (rank &lt; 4) delegate→sponsor request or a
                        sponsor→sponsor request — are never scheduled.
                    </p>
                )}
            </div>
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
