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
import { TierPill } from "./_components/TierPill";
import SchedulerReportPanel from "./SchedulerReportPanel";
import { pushAllForEvent, runSchedulerForEvent } from "./actions";
import type {
    SponsorRow,
    SponsorSortField,
    SponsorsPage,
} from "./actions";
import type { SchedulerReport } from "@/lib/scheduling/report";

// ---------------------------------------------------------------------------
// SponsorsTable — sponsor list for /admin/meetings.
//
// Mirrors the RequestsTable pattern: all view state (event, q, sort, dir,
// page) lives in the URL via hrefWith(). TanStack Table runs in manual mode
// and only owns the header sort UI and pagination controls.
// ---------------------------------------------------------------------------

type Props = {
    selectedEvent: string | null;
    query: string;
    sortField: SponsorSortField;
    sortDir: "asc" | "desc";
    data: SponsorsPage;
};

const COL_COUNT = 8;

export default function SponsorsTable({
    selectedEvent,
    query,
    sortField,
    sortDir,
    data,
}: Props) {
    const router = useRouter();
    const pathname = usePathname();

    const [showRunModal, setShowRunModal] = useState(false);
    const [runError, setRunError] = useState<string | null>(null);
    const [showPushAllModal, setShowPushAllModal] = useState(false);
    const [pushAllError, setPushAllError] = useState<string | null>(null);
    const [report, setReport] = useState<SchedulerReport | null>(null);
    const [isPending, startTransition] = useTransition();

    // Handler for running the scheduling engine for the selected event.
    function handleRunEngine() {
        if (!selectedEvent) return;
        startTransition(async () => {
            try {
                setRunError(null);
                const result = await runSchedulerForEvent(selectedEvent);
                setReport(result);
                setShowRunModal(false);
                router.refresh();
            } catch (e) {
                setRunError(e instanceof Error ? e.message : "An unexpected error occurred.");
            }
        });
    }

    // Handler for pushing all meetings for the selected event.
    function handlePushAll() {
        if (!selectedEvent) return;
        startTransition(async () => {
            try {
                setPushAllError(null);
                await pushAllForEvent(selectedEvent);
                setShowPushAllModal(false);
                router.refresh();
            } catch (e) {
                setPushAllError(e instanceof Error ? e.message : "An unexpected error occurred.");
            }
        });
    }

    // Generates a URL with the given query parameter overrides.
    function hrefWith(overrides: {
        q?: string;
        sort?: SponsorSortField;
        dir?: "asc" | "desc";
        page?: number;
    }): string {
        // Get current parameters from the URL.
        const params = new URLSearchParams();

        // For search, only include the parameter if it's non-empty after trimming.
        const q = overrides.q !== undefined ? overrides.q : query;
        if (q.trim()) params.set("q", q.trim());

        // Always include sort and dir since they have defaults.
        params.set("sort", overrides.sort ?? sortField);
        params.set("dir", overrides.dir ?? sortDir);

        // Include the page parameter if it's greater than 1 since the default is 1.
        const page = overrides.page ?? data.page;
        if (page > 1) params.set("page", String(page));

        // Construct the final URL with the updated query string.
        const qs = params.toString();
        return qs ? `${pathname}?${qs}` : pathname;
    }

    // Turn live search input into a query parameter update.
    const [searchInput, setSearchInput] = useState(query);
    useEffect(() => setSearchInput(query), [query]);
    const [debouncedSearch] = useDebounce(searchInput, 300); // Debounce to avoid spamming the URL on every keystroke.
    useEffect(() => {
        if (debouncedSearch.trim() === query.trim()) return;
        router.push(hrefWith({ q: debouncedSearch, page: 1 }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedSearch]);

    // TanStack table manual sorting.
    const sorting = useMemo<SortingState>(
        () => [{ id: sortField, desc: sortDir === "desc" }],
        [sortField, sortDir],
    );

    // TanskStack table manual pagination.
    const pagination = useMemo<PaginationState>(
        () => ({ pageIndex: data.page - 1, pageSize: data.pageSize }),
        [data.page, data.pageSize],
    );

    // Set up the table columns.
    const columns = useMemo<ColumnDef<SponsorRow>[]>(
        () => [
            { id: "company", header: "Company" },
            { id: "name", header: "Contact" },
            { id: "tier", header: "Tier" },
            { id: "contracted", header: "Contracted", enableSorting: false },
            { id: "bonus", header: "Bonus", enableSorting: false },
            { id: "total", header: "Total", enableSorting: false },
            { id: "requestCount", header: "Requests" },
            { id: "scheduledCount", header: "Scheduled" },
        ],
        [],
    );

    // Handle sorting changes.
    const onSortingChange: OnChangeFn<SortingState> = (updater) => {
        const next = typeof updater === "function" ? updater(sorting) : updater;
        const s = next[0] ?? { id: sortField, desc: false };
        router.push(
            hrefWith({
                sort: s.id as SponsorSortField,
                dir: s.desc ? "desc" : "asc",
                page: 1,
            }),
        );
    };

    // Handle pagination changes.
    const onPaginationChange: OnChangeFn<PaginationState> = (updater) => {
        const next =
            typeof updater === "function" ? updater(pagination) : updater;
        router.push(hrefWith({ page: next.pageIndex + 1 }));
    };

    // Set up the table instance.
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

    // Handler for changing the selected event.
    // Handler for navigating to a sponsor's detail page. The active event is
    // global (cookie-backed), so no event param is needed on the URL.
    function goToSponsor(salesforceId: string) {
        router.push(`/admin/meetings/${encodeURIComponent(salesforceId)}`);
    }

    // Render the table with toolbar and modals.
    return (
        <div className="adm-page">
            <div className="adm-page-head">
                <h1 className="adm-page-title">Manage Meetings</h1>
            </div>

            <div className="adm-toolbar">
                <input
                    type="search"
                    className="adm-input adm-search"
                    placeholder="Search sponsors…"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                />
                <button
                    className="adm-new-btn"
                    disabled={!selectedEvent || isPending}
                    onClick={() => { setRunError(null); setShowRunModal(true); }}
                >
                    {isPending ? "Running…" : "Run Scheduling Engine"}
                </button>
                <button
                    className="adm-new-btn"
                    disabled={!selectedEvent || isPending}
                    onClick={() => { setPushAllError(null); setShowPushAllModal(true); }}
                >
                    Push All to Cvent
                </button>
            </div>

            {showRunModal && selectedEvent && (
                <RunEngineModal
                    eventCode={selectedEvent}
                    isPending={isPending}
                    error={runError}
                    onConfirm={handleRunEngine}
                    onCancel={() => setShowRunModal(false)}
                />
            )}

            {showPushAllModal && selectedEvent && (
                <PushAllModal
                    eventCode={selectedEvent}
                    isPending={isPending}
                    error={pushAllError}
                    onConfirm={handlePushAll}
                    onCancel={() => setShowPushAllModal(false)}
                />
            )}

            {report && (
                <SchedulerReportPanel
                    report={report}
                    onDismiss={() => setReport(null)}
                />
            )}

            <table className="adm-table">
                <SortableHeaders table={table} actionsColumnId="__none__" />
                <tbody>
                    {data.rows.length === 0 ? (
                        <tr>
                            <td colSpan={COL_COUNT} className="adm-empty">
                                {query
                                    ? "No sponsors match your search."
                                    : selectedEvent
                                      ? "No sponsors found for this event."
                                      : "No events found. Add meeting requests first."}
                            </td>
                        </tr>
                    ) : (
                        data.rows.map((row) => (
                            <SponsorRow
                                key={row.salesforceId}
                                row={row}
                                onView={() => goToSponsor(row.salesforceId)}
                            />
                        ))
                    )}
                </tbody>
            </table>

            <TablePagination
                table={table}
                total={data.total}
                noun="sponsor"
                busy={false}
            />
        </div>
    );
}

// ---------------------------------------------------------------------------
// SponsorRow — one row in the sponsor list.
// ---------------------------------------------------------------------------

function SponsorRow({
    row,
    onView,
}: {
    row: SponsorRow;
    onView: () => void;
}) {
    // Calculate the total meetings (contracted + bonus) and the percentage of scheduled meetings for the progress bar.
    const total = row.contracted + row.bonus;
    const scheduledPercent = total > 0 ? Math.round((row.scheduledCount / total) * 100) : 0;

    // Check if the sponsor is over their meeting target.
    const isOver = row.scheduledCount > total;
    const barColor = isOver
        ? "var(--red)"
        : scheduledPercent >= 100
          ? "var(--green)"
          : scheduledPercent >= 85
            ? "var(--gold)"
            : "var(--blue)";

    // Render the sponsor row with company, contact, tier, contracted/bonus totals, request/scheduled counts, and a progress bar for scheduled meetings.
    return (
        <tr className="adm-row adm-row-clickable" onClick={onView}>
            <td>
                <div className="adm-party-name">{row.company}</div>
            </td>
            <td>
                <div className="adm-party-name">{row.name}</div>
                <div className="adm-party-company">{row.title}</div>
            </td>
            <td>
                <TierPill tier={row.sponsorTier} />
            </td>
            <td className="adm-mono">{row.contracted}</td>
            <td className="adm-mono-dim">{row.bonus > 0 ? `+${row.bonus}` : "—"}</td>
            <td className="adm-mono">{total}</td>
            <td className="adm-mono-dim">{row.requestCount}</td>
            <td>
                <div className="adm-progress">
                    <div className="adm-progress-track">
                        <div
                            className="adm-progress-bar"
                            style={{ width: `${Math.min(scheduledPercent, 100)}%`, background: barColor }}
                        />
                    </div>
                    <span className="adm-progress-label">{row.scheduledCount} / {total}</span>
                </div>
            </td>
        </tr>
    );
}

// ---------------------------------------------------------------------------
// PushAllModal — confirmation dialog for the event-wide bulk push.
// ---------------------------------------------------------------------------

function PushAllModal({
    eventCode,
    isPending,
    error,
    onConfirm,
    onCancel,
}: {
    eventCode: string;
    isPending: boolean;
    error: string | null;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="adm-modal-overlay">
            <div className="adm-modal adm-modal-md">
                <div className="adm-modal-title">Push All to Cvent?</div>
                <p className="adm-modal-body">
                    This will push all un-synced portal meetings for{" "}
                    <strong>{eventCode}</strong>{" "}
                    to Cvent, including meetings that have been modified since their
                    last push.
                </p>
                {error && <div className="adm-modal-error">{error}</div>}
                <div className="adm-modal-actions">
                    <button className="adm-btn" onClick={onCancel} disabled={isPending}>Cancel</button>
                    <button className="adm-btn adm-btn-primary" onClick={onConfirm} disabled={isPending}>
                        {isPending ? "Pushing…" : "Push All"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// RunEngineModal — confirmation dialog for the scheduling engine run.
// ---------------------------------------------------------------------------

function RunEngineModal({
    eventCode,
    isPending,
    error,
    onConfirm,
    onCancel,
}: {
    eventCode: string;
    isPending: boolean;
    error: string | null;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="adm-modal-overlay">
            <div className="adm-modal adm-modal-md">
                <div className="adm-modal-title">Run Scheduling Engine?</div>
                <p className="adm-modal-body">
                    This will replace all un-pushed meetings for{" "}
                    <strong>{eventCode}</strong>{" "}
                    with fresh engine output. Meetings already pushed to Cvent are
                    preserved and count against per-sponsor caps.
                </p>
                {error && <div className="adm-modal-error">{error}</div>}
                <div className="adm-modal-actions">
                    <button className="adm-btn" onClick={onCancel} disabled={isPending}>Cancel</button>
                    <button className="adm-btn adm-btn-primary" onClick={onConfirm} disabled={isPending}>
                        {isPending ? "Running…" : "Run Engine"}
                    </button>
                </div>
            </div>
        </div>
    );
}
