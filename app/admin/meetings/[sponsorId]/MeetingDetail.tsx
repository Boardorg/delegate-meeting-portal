"use client";

import Link from "next/link";
import { useMemo } from "react";
import { fmtTime } from "@/lib/format";
import type { MeetingMatchKind, MeetingSource } from "@/types";
import type { MeetingRow, SponsorDetail, SyncStatus } from "./actions";

// ---------------------------------------------------------------------------
// MeetingDetail — per-sponsor meeting table for /admin/meetings/[sponsorId].
//
// TODO: Need to add Edit / Remove / Push / Create actions.
// ---------------------------------------------------------------------------

type Props = {
    sponsor: SponsorDetail;
    meetings: MeetingRow[];
    eventCode: string;
};

export default function MeetingDetail({ sponsor, meetings, eventCode }: Props) {
    const total = sponsor.contracted + sponsor.bonus;
    const listHref = `/admin/meetings?event=${encodeURIComponent(eventCode)}`;

    // Detect duplicate delegate companies within this sponsor's meetings.
    const conflictCompanies = useMemo(() => {
        const counts = new Map<string, number>();
        for (const m of meetings) {
            if (m.delegateCompany)
                counts.set(m.delegateCompany, (counts.get(m.delegateCompany) ?? 0) + 1);
        }
        return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([c]) => c));
    }, [meetings]);

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

                {/* Stat chips */}
                <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
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
                            sponsor.scheduledCount >= total
                                ? "var(--green)"
                                : sponsor.scheduledCount > 0
                                  ? "var(--text)"
                                  : "var(--gold)"
                        }
                    />
                </div>
            </div>

            {/* Legend */}
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "16px",
                    marginBottom: "14px",
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

            {/* Meeting table */}
            {meetings.length === 0 ? (
                <div className="adm-empty" style={{ padding: "48px 24px" }}>
                    No meetings scheduled yet.
                </div>
            ) : (
                <div style={{ overflowX: "auto" }}>
                    <table
                        className="adm-table"
                        style={{ minWidth: "860px" }}
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
                            </tr>
                        </thead>
                        <tbody>
                            {meetings.map((m) => (
                                <MeetingTableRow
                                    key={m.id}
                                    meeting={m}
                                    hasConflict={conflictCompanies.has(m.delegateCompany)}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
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
}: {
    meeting: MeetingRow;
    hasConflict: boolean;
}) {
    const isCvent = m.source === "cvent";

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
        </tr>
    );
}

// ---------------------------------------------------------------------------
// Chips + small display components
// ---------------------------------------------------------------------------

function MatchKindChip({ kind }: { kind: MeetingMatchKind }) {
    const styles: Record<MeetingMatchKind, { bg: string; color: string; border: string; label: string }> = {
        mutual:          { bg: "var(--green-s)",               color: "var(--green)",  border: "var(--green-b)",                   label: "Mutual" },
        sponsor_choice:  { bg: "var(--blue-s)",                color: "var(--blue)",   border: "var(--blue-b)",                    label: "Sponsor choice" },
        delegate_choice: { bg: "rgba(155,114,245,0.1)",        color: "var(--purple)", border: "rgba(155,114,245,0.25)",           label: "Delegate choice" },
        admin:           { bg: "rgba(240,160,32,0.1)",         color: "var(--gold)",   border: "rgba(240,160,32,0.3)",            label: "Admin created" },
    };
    const s = styles[kind];
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

function SyncChip({ status }: { status: SyncStatus }) {
    const styles: Record<SyncStatus, { bg: string; color: string; border: string; label: string }> = {
        synced:     { bg: "var(--green-s)", color: "var(--green)", border: "var(--green-b)", label: "Synced" },
        modified:   { bg: "rgba(240,160,32,0.1)", color: "var(--gold)", border: "rgba(240,160,32,0.3)", label: "Modified" },
        not_pushed: { bg: "var(--s3)", color: "var(--t2)", border: "var(--border)", label: "Not pushed" },
    };
    const s = styles[status];
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

function SourceChip({ source }: { source: MeetingSource }) {
    const isPortal = source === "portal";
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

function TierPill({ tier }: { tier: "diamond" | "standard" }) {
    const isDiamond = tier === "diamond";
    return (
        <span
            style={{
                fontSize: "10px",
                padding: "2px 8px",
                borderRadius: "100px",
                fontWeight: 500,
                background: isDiamond ? "rgba(155,114,245,0.12)" : "rgba(46,201,126,0.1)",
                color: isDiamond ? "var(--purple)" : "var(--green)",
                border: `1px solid ${isDiamond ? "rgba(155,114,245,0.25)" : "rgba(46,201,126,0.3)"}`,
            }}
        >
            {isDiamond ? "◆ Diamond" : "● Standard"}
        </span>
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
