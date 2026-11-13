// ---------------------------------------------------------------------------
// A meeting's Cvent sync status, derived from its database row.
// Shared by the sponsor meeting page and the Overview, so their counts agree.
// Pure, so it can be tested without the database or Cvent.
// ---------------------------------------------------------------------------

/** Derived Cvent sync status for a single meeting row. */
export type SyncStatus = "synced" | "modified" | "not_pushed";

/** The fields of a meeting row that decide its sync status. */
export type SyncFields = {
    cventAppointmentId: string | null;
    lastModifiedAt: Date | null;
    lastPushedAt: Date | null;
};

/**
 * Derives the Cvent sync status for a DB meeting row.
 * Not pushed if cventAppointmentId is null. Modified if the meeting was
 * edited after it was last pushed. Synced otherwise.
 */
export function getSyncStatus(m: SyncFields): SyncStatus {
    if (!m.cventAppointmentId) return "not_pushed";
    if (m.lastModifiedAt && m.lastPushedAt && m.lastModifiedAt > m.lastPushedAt)
        return "modified";
    return "synced";
}
