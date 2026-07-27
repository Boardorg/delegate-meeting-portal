"use client";

import type { SyncFailureReason, SyncReport } from "@/lib/cvent/syncReport";

// ---------------------------------------------------------------------------
// SyncReportPanel — post-sync summary shown above the meetings table.
//
// Renders the ephemeral SyncReport returned by pushAllForEvent: headline
// counts (already synced / attempted / created / updated / failed) and, for
// each failed meeting, a categorized, actionable reason plus the technical
// detail behind it. Pure presentation over a serializable report.
// ---------------------------------------------------------------------------

const GREEN = "#2ec97e";
const RED = "#e8391e";

// Short label per failure reason, for the reason tag.
const REASON_LABEL: Record<SyncFailureReason, string> = {
    missing_timeslot: "Timeslot missing",
    missing_location: "No location",
    host_not_in_cvent: "Host not in Cvent",
    cvent_no_availability: "Host slot full",
    cvent_validation: "Rejected by Cvent",
    cvent_conflict: "Cvent conflict",
    cvent_not_found: "Not found in Cvent",
    cvent_auth: "Cvent auth failed",
    cvent_rate_limited: "Rate limited",
    cvent_server_error: "Cvent server error",
    network_error: "Network error",
    unknown: "Unknown error",
};

// One-line, actionable next step per reason.
const REASON_HINT: Record<SyncFailureReason, string> = {
    missing_timeslot: "The meeting's timeslot no longer exists in Cvent.",
    missing_location: "Assign a location to the meeting before syncing.",
    host_not_in_cvent:
        "The requester (appointment host) isn't a Cvent attendee for this event. Add them in Cvent, then sync again.",
    cvent_no_availability:
        "Cvent reports the host has no appointment slot free at this time. Move the meeting to another timeslot.",
    cvent_validation:
        "Cvent rejected the appointment data. Check the meeting's participants, location, and time.",
    cvent_conflict:
        "Cvent reports a conflicting or duplicate appointment. Check whether it already exists in Cvent.",
    cvent_not_found:
        "Cvent couldn't find a referenced record (host, location, or event). Verify the event's Cvent settings.",
    cvent_auth:
        "The Cvent credentials are invalid or lack permission. Check the Cvent API settings and try again.",
    cvent_rate_limited:
        "Cvent throttled the request. Wait a moment and sync again.",
    cvent_server_error:
        "Cvent had an internal error. This is usually transient — retry shortly.",
    network_error:
        "The request didn't reach Cvent. Check connectivity, then sync again.",
    unknown: "An unexpected error occurred. See the detail below.",
};

export default function SyncReportPanel({
    report,
    onDismiss,
}: {
    report: SyncReport;
    onDismiss: () => void;
}) {
    const nothingToDo = report.attempted === 0;

    return (
        <div className="adm-card">
            <div className="adm-card-head">
                <div>
                    <div className="adm-card-title">Cvent Sync Results</div>
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
                    label="Total meetings"
                    value={String(report.totalPortalMeetings)}
                />
                <StatChip
                    label="Already synced"
                    value={String(report.alreadySynced)}
                />
                <StatChip label="Attempted" value={String(report.attempted)} />
                <StatChip
                    label="Created"
                    value={String(report.created)}
                    valueColor={report.created > 0 ? GREEN : undefined}
                />
                <StatChip
                    label="Updated"
                    value={String(report.updated)}
                    valueColor={report.updated > 0 ? GREEN : undefined}
                />
                <StatChip
                    label="Failed"
                    value={String(report.failed)}
                    valueColor={report.failed > 0 ? RED : undefined}
                />
            </div>

            {nothingToDo && report.failed === 0 && (
                <p className="adm-help-note">
                    Nothing to sync — every meeting for this event is already up
                    to date in Cvent.
                </p>
            )}

            {report.failures.length > 0 && (
                <div style={{ marginTop: 20 }}>
                    <div className="adm-chart-title">
                        Failed to sync ({report.failures.length})
                    </div>
                    <ul className="adm-sync-list">
                        {report.failures.map((f) => (
                            <li key={f.meetingId} className="adm-sync-item">
                                <div className="adm-sync-head">
                                    <span className="adm-party-name">
                                        {f.label}
                                    </span>
                                    <span className="adm-sync-reason">
                                        {REASON_LABEL[f.reason]}
                                    </span>
                                </div>
                                <div className="adm-sync-hint">
                                    {REASON_HINT[f.reason]}
                                </div>
                                <div className="adm-sync-detail">
                                    {f.detail}
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {report.warnings.length > 0 && (
                <div style={{ marginTop: 20 }}>
                    <div className="adm-chart-title">
                        Synced with warnings ({report.warnings.length})
                    </div>
                    <ul className="adm-sync-list">
                        {report.warnings.map((w) => (
                            <li
                                key={w.meetingId}
                                className="adm-sync-item adm-sync-item-warn"
                            >
                                <div className="adm-party-name">{w.label}</div>
                                <div className="adm-sync-detail">
                                    {w.detail}
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
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
