"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
    getCoreRowModel,
    useReactTable,
    type ColumnDef,
    type OnChangeFn,
    type PaginationState,
    type SortingState,
} from "@tanstack/react-table";
import { useDebounce } from "use-debounce";
import { SortableHeaders } from "../_components/SortableHeaders";
import { TablePagination } from "../_components/TablePagination";
import { ConfirmModal } from "../meetings/_components/ConfirmModal";
import { ProgressCell } from "../meetings/_components/ProgressCell";
import SyncReportPanel from "../meetings/SyncReportPanel";
import MaintenanceReportPanel from "../meetings/MaintenanceReportPanel";
import type { MaintenanceReport } from "../meetings/actions";
import D2DReportPanel from "./D2DReportPanel";
import {
    clearUnsyncedD2DForEvent,
    pushAllD2DForEvent,
    runD2DForEvent,
    unpushAllD2DForEvent,
    type DelegateRow,
    type DelegateSortField,
    type DelegatesPage,
} from "./actions";
import type { D2DReport } from "@/lib/matching/d2dReport";
import type { SyncReport } from "@/lib/cvent/syncReport";

// ---------------------------------------------------------------------------
// DelegatesTable: the delegate list for /admin/delegate-meetings.
//
// Mirrors SponsorsTable on the Sponsor Meetings page: the same header buttons and confirmations,
// the same report panels, and search, sort and page kept in the URL.
// Clicking a delegate opens their meetings.
// ---------------------------------------------------------------------------

type Props = {
    selectedEvent: string | null;
    query: string;
    sortField: DelegateSortField;
    sortDir: "asc" | "desc";
    data: DelegatesPage;
    /** Shown before a run when no S2D meetings exist yet. The run still goes ahead. */
    orderWarning: string | null;
};

const COL_COUNT = 5;

/** Which confirmation is open. */
type OpenModal = "run" | "push" | "clear" | "unpush" | null;

/**
 * Renders the Delegate Meetings list, its header buttons and their reports.
 *
 * @param {Props} props - The event, the view state and the page of rows.
 * @returns {JSX.Element} The page body.
 */
export default function DelegatesTable({ selectedEvent, query, sortField, sortDir, data, orderWarning }: Props) {
    const router = useRouter();
    const pathname = usePathname();

    const [openModal, setOpenModal] = useState<OpenModal>(null);
    const [modalError, setModalError] = useState<string | null>(null);
    const [report, setReport] = useState<D2DReport | null>(null);
    const [syncReport, setSyncReport] = useState<SyncReport | null>(null);
    const [maintenanceReport, setMaintenanceReport] = useState<MaintenanceReport | null>(null);
    const [isPending, startTransition] = useTransition();

    /**
     * Opens a confirmation with no error showing.
     *
     * @param {OpenModal} which - The confirmation to open.
     */
    function open(which: OpenModal) {
        setModalError(null);
        setOpenModal(which);
    }

    /**
     * Runs a header action, closes its confirmation and refreshes the list.
     * A thrown error stays in the confirmation.
     *
     * @param {() => Promise<void>} action - The work to do.
     */
    function run(action: () => Promise<void>) {
        startTransition(async () => {
            try {
                setModalError(null);
                await action();
                router.refresh();
            } catch (e) {
                setModalError(e instanceof Error ? e.message : "An unexpected error occurred.");
            }
        });
    }

    /** Runs D2D matching. A stopped run keeps the confirmation open with its message. */
    function handleRun() {
        if (!selectedEvent) return;
        run(async () => {
            const result = await runD2DForEvent(selectedEvent);
            if (!result.ok) {
                setModalError(result.error);
                return;
            }
            setReport(result.report);
            setOpenModal(null);
        });
    }

    /** Pushes every unsynced D2D meeting. */
    function handlePushAll() {
        if (!selectedEvent) return;
        run(async () => {
            setSyncReport(await pushAllD2DForEvent(selectedEvent));
            setOpenModal(null);
        });
    }

    /** Deletes every D2D meeting not pushed to Cvent. */
    function handleClear() {
        if (!selectedEvent) return;
        run(async () => {
            setMaintenanceReport(await clearUnsyncedD2DForEvent(selectedEvent));
            setOpenModal(null);
        });
    }

    /** Cancels every synced D2D meeting in Cvent, keeping the meetings. */
    function handleUnpush() {
        if (!selectedEvent) return;
        run(async () => {
            setMaintenanceReport(await unpushAllD2DForEvent(selectedEvent));
            setOpenModal(null);
        });
    }

    /**
     * Builds the list URL with some view settings changed.
     *
     * @param {{ q?: string; sort?: DelegateSortField; dir?: "asc" | "desc"; page?: number }} overrides - The settings to change.
     * @returns {string} The URL.
     */
    function hrefWith(overrides: { q?: string; sort?: DelegateSortField; dir?: "asc" | "desc"; page?: number }): string {
        const params = new URLSearchParams();
        const q = overrides.q !== undefined ? overrides.q : query;
        if (q.trim()) params.set("q", q.trim());
        params.set("sort", overrides.sort ?? sortField);
        params.set("dir", overrides.dir ?? sortDir);
        const page = overrides.page ?? data.page;
        if (page > 1) params.set("page", String(page));
        const qs = params.toString();
        return qs ? `${pathname}?${qs}` : pathname;
    }

    // Turn live search input into a query parameter update.
    const [searchInput, setSearchInput] = useState(query);
    useEffect(() => setSearchInput(query), [query]);
    const [debouncedSearch] = useDebounce(searchInput, 300);
    useEffect(() => {
        if (debouncedSearch.trim() === query.trim()) return;
        router.push(hrefWith({ q: debouncedSearch, page: 1 }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedSearch]);

    const sorting = useMemo<SortingState>(() => [{ id: sortField, desc: sortDir === "desc" }], [sortField, sortDir]);
    const pagination = useMemo<PaginationState>(
        () => ({ pageIndex: data.page - 1, pageSize: data.pageSize }),
        [data.page, data.pageSize],
    );
    const columns = useMemo<ColumnDef<DelegateRow>[]>(
        () => [
            { id: "name", header: "Delegate" },
            { id: "company", header: "Company" },
            { id: "s2dCount", header: "S2D Meetings" },
            { id: "d2dCount", header: "D2D Meetings" },
            { id: "sync", header: "Cvent Sync", enableSorting: false },
        ],
        [],
    );

    const onSortingChange: OnChangeFn<SortingState> = (updater) => {
        const next = typeof updater === "function" ? updater(sorting) : updater;
        const s = next[0] ?? { id: sortField, desc: false };
        router.push(hrefWith({ sort: s.id as DelegateSortField, dir: s.desc ? "desc" : "asc", page: 1 }));
    };
    const onPaginationChange: OnChangeFn<PaginationState> = (updater) => {
        const next = typeof updater === "function" ? updater(pagination) : updater;
        router.push(hrefWith({ page: next.pageIndex + 1 }));
    };

    const table = useReactTable({
        data: data.rows,
        columns,
        getCoreRowModel: getCoreRowModel(),
        manualSorting: true,
        manualPagination: true,
        enableSortingRemoval: false,
        pageCount: data.pageCount,
        state: { sorting, pagination },
        onSortingChange,
        onPaginationChange,
    });

    return (
        <div className="adm-page">
            <div className="adm-page-head">
                <h1 className="adm-page-title">Delegate Meetings</h1>
            </div>

            <div className="adm-toolbar">
                <input
                    type="search"
                    className="adm-input adm-search"
                    placeholder="Search delegates…"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                />
                <button
                    className="adm-new-btn adm-new-btn-primary"
                    disabled={!selectedEvent || isPending}
                    onClick={() => open("run")}
                >
                    {isPending ? "Running…" : "Run D2D Matching"}
                </button>
                <button
                    className="adm-new-btn adm-new-btn-primary"
                    disabled={!selectedEvent || isPending}
                    onClick={() => open("push")}
                >
                    {isPending ? "Working…" : "Push All to Cvent"}
                </button>
                <button
                    className="adm-new-btn adm-new-btn-danger"
                    disabled={!selectedEvent || isPending}
                    onClick={() => open("clear")}
                >
                    {isPending ? "Working…" : "Clear All Unsynced"}
                </button>
                <button
                    className="adm-new-btn adm-new-btn-danger-solid"
                    disabled={!selectedEvent || isPending}
                    onClick={() => open("unpush")}
                >
                    {isPending ? "Working…" : "Unpush All Synced"}
                </button>
            </div>

            {openModal === "run" && selectedEvent && (
                <ConfirmModal
                    title="Run D2D Matching?"
                    confirmLabel="Run Matching"
                    pendingLabel="Running…"
                    isPending={isPending}
                    error={modalError}
                    onConfirm={handleRun}
                    onCancel={() => setOpenModal(null)}
                >
                    <p className="adm-modal-body">
                        This will replace all un-pushed D2D meetings for <strong>{selectedEvent}</strong> with
                        fresh matches. D2D meetings already pushed to Cvent are kept, and sponsor meetings
                        are never changed.
                    </p>
                    {orderWarning && (
                        <div className="adm-modal-warn-at" role="alert" style={{ marginBottom: 16 }}>
                            {orderWarning}
                        </div>
                    )}
                </ConfirmModal>
            )}

            {openModal === "push" && selectedEvent && (
                <ConfirmModal
                    title="Push All to Cvent?"
                    confirmLabel="Push All"
                    pendingLabel="Pushing…"
                    isPending={isPending}
                    error={modalError}
                    onConfirm={handlePushAll}
                    onCancel={() => setOpenModal(null)}
                >
                    <p className="adm-modal-body">
                        This will push all un-synced D2D meetings for <strong>{selectedEvent}</strong> to
                        Cvent, including meetings that have been modified since their last push.
                    </p>
                </ConfirmModal>
            )}

            {openModal === "clear" && selectedEvent && (
                <ConfirmModal
                    title="Clear All Unsynced Meetings?"
                    confirmLabel="Clear Unsynced"
                    pendingLabel="Clearing…"
                    tone="danger"
                    isPending={isPending}
                    error={modalError}
                    onConfirm={handleClear}
                    onCancel={() => setOpenModal(null)}
                >
                    <p className="adm-modal-body">
                        This permanently deletes every D2D meeting for <strong>{selectedEvent}</strong> that
                        has not been pushed to Cvent. Meetings already synced to Cvent are kept. This cannot
                        be undone.
                    </p>
                </ConfirmModal>
            )}

            {openModal === "unpush" && selectedEvent && (
                <ConfirmModal
                    title="Unpush All Synced Meetings?"
                    confirmLabel="Unpush All"
                    pendingLabel="Unpushing…"
                    tone="danger"
                    isPending={isPending}
                    error={modalError}
                    onConfirm={handleUnpush}
                    onCancel={() => setOpenModal(null)}
                >
                    <p className="adm-modal-body">
                        This cancels the Cvent appointment behind every synced D2D meeting for{" "}
                        <strong>{selectedEvent}</strong>. The meetings stay in the portal but return to
                        un-synced. This cannot be undone.
                    </p>
                </ConfirmModal>
            )}

            {report && <D2DReportPanel report={report} onDismiss={() => setReport(null)} />}
            {syncReport && <SyncReportPanel report={syncReport} onDismiss={() => setSyncReport(null)} />}
            {maintenanceReport && (
                <MaintenanceReportPanel report={maintenanceReport} onDismiss={() => setMaintenanceReport(null)} />
            )}

            <table className="adm-table">
                <SortableHeaders table={table} actionsColumnId="__none__" />
                <tbody>
                    {data.rows.length === 0 ? (
                        <tr>
                            <td colSpan={COL_COUNT} className="adm-empty">
                                {query
                                    ? "No delegates match your search."
                                    : selectedEvent
                                      ? "No delegates can be matched for this event."
                                      : "No events found."}
                            </td>
                        </tr>
                    ) : (
                        data.rows.map((row) => (
                            <DelegateTableRow
                                key={row.delegateId}
                                row={row}
                                onView={() => router.push(`/admin/delegate-meetings/${encodeURIComponent(row.delegateId)}`)}
                            />
                        ))
                    )}
                </tbody>
            </table>

            <TablePagination table={table} total={data.total} noun="delegate" busy={false} />
        </div>
    );
}

/**
 * One delegate row in the list.
 *
 * @param {{ row: DelegateRow; onView: () => void }} props - The row and the click handler.
 * @returns {JSX.Element} The table row.
 */
function DelegateTableRow({ row, onView }: { row: DelegateRow; onView: () => void }) {
    const percent = row.d2dCap > 0 ? Math.round((row.d2dCount / row.d2dCap) * 100) : 0;
    return (
        <tr className="adm-row adm-row-clickable" onClick={onView}>
            <td>
                <div className="adm-party-name">{row.name}</div>
                {row.exclusion && (
                    <div className="adm-chip-mt">
                        <span className="adm-chip adm-chip-cancelled">{EXCLUSION_LABEL[row.exclusion]}</span>
                    </div>
                )}
            </td>
            <td>{row.company || "—"}</td>
            <td className="adm-mono">{row.s2dCount}</td>
            <td>
                <ProgressCell count={row.d2dCount} total={row.d2dCap} percent={percent} />
            </td>
            <td>
                <SyncSummary sync={row.sync} />
            </td>
        </tr>
    );
}

/** Plain words for why a delegate can't be matched. */
const EXCLUSION_LABEL: Record<NonNullable<DelegateRow["exclusion"]>, string> = {
    conference_only: "Conference only",
    incomplete_profile: "Profile not complete",
    cancelled: "Cancelled in Cvent",
};

/**
 * A delegate's D2D meetings by sync state, as chips.
 * Shows a dash when they have no portal D2D meetings.
 *
 * @param {{ sync: DelegateRow["sync"] }} props - The counts.
 * @returns {JSX.Element} The chips.
 */
function SyncSummary({ sync }: { sync: DelegateRow["sync"] }) {
    if (sync.synced + sync.modified + sync.notPushed === 0) return <span className="adm-dim">—</span>;
    return (
        <span className="adm-chip-mt">
            {sync.synced > 0 && <span className="adm-chip adm-chip-synced">{sync.synced} Synced</span>}{" "}
            {sync.modified > 0 && <span className="adm-chip adm-chip-modified">{sync.modified} Modified</span>}{" "}
            {sync.notPushed > 0 && <span className="adm-chip adm-chip-not-pushed">{sync.notPushed} Not pushed</span>}
        </span>
    );
}
