"use client";

import type { MeetingMatchKind, MeetingSource } from "@/lib/db/schema";
import type { SyncStatus } from "@/lib/cvent/syncStatus";

// ---------------------------------------------------------------------------
// Chips + small display components
// Moved out of app/admin/meetings/[sponsorId]/MeetingDetail.tsx so the delegate meeting page can use them too.
// ---------------------------------------------------------------------------

/**
 * A chip naming how a meeting was made.
 *
 * @param {{ kind: MeetingMatchKind }} props - The meeting's match kind.
 * @returns {JSX.Element} The chip.
 */
export function MatchKindChip({ kind }: { kind: MeetingMatchKind }) {
    const classMap: Record<MeetingMatchKind, string> = {
        mutual:          "adm-chip-mutual",
        sponsor_choice:  "adm-chip-sponsor-choice",
        delegate_choice: "adm-chip-delegate-choice",
        admin:           "adm-chip-admin",
        profile_match:   "adm-chip-sponsor-choice",
    };
    const labelMap: Record<MeetingMatchKind, string> = {
        mutual:          "Mutual",
        sponsor_choice:  "Sponsor choice",
        delegate_choice: "Delegate choice",
        admin:           "Admin created",
        profile_match:   "Profile match",
    };
    return <span className={`adm-chip ${classMap[kind]}`}>{labelMap[kind]}</span>;
}

/**
 * A chip naming a meeting's Cvent sync status.
 *
 * @param {{ status: SyncStatus }} props - The status.
 * @returns {JSX.Element} The chip.
 */
export function SyncChip({ status }: { status: SyncStatus }) {
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

/**
 * A chip naming where a meeting comes from, the portal or Cvent.
 *
 * @param {{ source: MeetingSource }} props - The source.
 * @returns {JSX.Element} The chip.
 */
export function SourceChip({ source }: { source: MeetingSource }) {
    return (
        <span className={`adm-chip ${source === "portal" ? "adm-chip-portal" : "adm-chip-cvent"}`}>
            {source === "portal" ? "Portal" : "Cvent"}
        </span>
    );
}

/**
 * One swatch and label in a table legend.
 *
 * @param {{ swatch: React.CSSProperties; label: string }} props - The swatch style and label.
 * @returns {JSX.Element} The legend item.
 */
export function LegendItem({ swatch, label }: { swatch: React.CSSProperties; label: string; }) {
    return (
        <span className="adm-legend-item">
            <span className="adm-legend-swatch" style={swatch} />
            {label}
        </span>
    );
}
