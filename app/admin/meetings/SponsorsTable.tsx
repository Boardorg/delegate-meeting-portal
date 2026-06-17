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
import { runSchedulerForEvent } from "./actions";
import type {
    SponsorRow,
    SponsorSortField,
    SponsorsPage,
} from "./actions";

// ---------------------------------------------------------------------------
// SponsorsTable — sponsor list for /admin/meetings.
//
// Mirrors the RequestsTable pattern: all view state (event, q, sort, dir,
// page) lives in the URL via hrefWith(). TanStack Table runs in manual mode
// and only owns the header sort UI and pagination controls.
// ---------------------------------------------------------------------------

type Props = {
    eventCodes: string[];
    selectedEvent: string | null;
    query: string;
    sortField: SponsorSortField;
    sortDir: "asc" | "desc";
    data: SponsorsPage;
};

const COL_COUNT = 8;

export default function SponsorsTable({
    eventCodes,
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
    const [isPending, startTransition] = useTransition();

    function handleRunEngine() {
        if (!selectedEvent) return;
        startTransition(async () => {
            try {
                setRunError(null);
                await runSchedulerForEvent(selectedEvent);
                setShowRunModal(false);
                router.refresh();
            } catch (e) {
                setRunError(e instanceof Error ? e.message : "An unexpected error occurred.");
            }
        });
    }

    function hrefWith(overrides: {
        event?: string | null;
        q?: string;
        sort?: SponsorSortField;
        dir?: "asc" | "desc";
        page?: number;
    }): string {
        const params = new URLSearchParams();
        const event =
            overrides.event !== undefined ? overrides.event : selectedEvent;
        if (event) params.set("event", event);
        const q = overrides.q !== undefined ? overrides.q : query;
        if (q.trim()) params.set("q", q.trim());
        params.set("sort", overrides.sort ?? sortField);
        params.set("dir", overrides.dir ?? sortDir);
        const page = overrides.page ?? data.page;
        if (page > 1) params.set("page", String(page));
        const qs = params.toString();
        return qs ? `${pathname}?${qs}` : pathname;
    }

    // Live search → URL
    const [searchInput, setSearchInput] = useState(query);
    useEffect(() => setSearchInput(query), [query]);
    const [debouncedSearch] = useDebounce(searchInput, 300);
    useEffect(() => {
        if (debouncedSearch.trim() === query.trim()) return;
        router.push(hrefWith({ q: debouncedSearch, page: 1 }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedSearch]);

    // TanStack table (manual sorting + pagination)
    const sorting = useMemo<SortingState>(
        () => [{ id: sortField, desc: sortDir === "desc" }],
        [sortField, sortDir],
    );
    const pagination = useMemo<PaginationState>(
        () => ({ pageIndex: data.page - 1, pageSize: data.pageSize }),
        [data.page, data.pageSize],
    );

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

    const onPaginationChange: OnChangeFn<PaginationState> = (updater) => {
        const next =
            typeof updater === "function" ? updater(pagination) : updater;
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

    function changeEvent(code: string) {
        router.push(hrefWith({ event: code, page: 1 }));
    }

    function goToSponsor(salesforceId: string) {
        const base = `/admin/meetings/${encodeURIComponent(salesforceId)}`;
        const event = selectedEvent ? `?event=${encodeURIComponent(selectedEvent)}` : "";
        router.push(`${base}${event}`);
    }

    return (
        <div className="adm-page">
            <div className="adm-page-head">
                <h1 className="adm-page-title">Manage Meetings</h1>
            </div>

            <div className="adm-toolbar">
                <label className="adm-field">
                    <span className="adm-field-label">Event</span>
                    <select
                        className="adm-input adm-select"
                        value={selectedEvent ?? ""}
                        onChange={(e) => changeEvent(e.target.value)}
                        disabled={eventCodes.length === 0}
                    >
                        {eventCodes.length === 0 ? (
                            <option value="">No events</option>
                        ) : (
                            eventCodes.map((code) => (
                                <option key={code} value={code}>
                                    {code}
                                </option>
                            ))
                        )}
                    </select>
                </label>
                <input
                    type="search"
                    className="adm-input adm-search"
                    placeholder="Search sponsors…"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                />
                <button
                    className="adm-new-btn"
                    disabled={!selectedEvent}
                    onClick={() => { setRunError(null); setShowRunModal(true); }}
                >
                    Run Scheduling Engine
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
    const total = row.contracted + row.bonus;
    const pct = total > 0 ? Math.round((row.scheduledCount / total) * 100) : 0;
    const barColor =
        pct >= 100 ? "var(--green)" : pct >= 85 ? "var(--gold)" : "var(--blue)";

    return (
        <tr
            className="adm-row"
            style={{ cursor: "pointer" }}
            onClick={onView}
        >
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
            <td style={{ fontFamily: "var(--mono)", fontSize: "12px" }}>
                {row.contracted}
            </td>
            <td
                style={{
                    fontFamily: "var(--mono)",
                    fontSize: "12px",
                    color: "var(--t2)",
                }}
            >
                {row.bonus > 0 ? `+${row.bonus}` : "—"}
            </td>
            <td style={{ fontFamily: "var(--mono)", fontSize: "12px" }}>
                {total}
            </td>
            <td
                style={{
                    fontFamily: "var(--mono)",
                    fontSize: "12px",
                    color: "var(--t2)",
                }}
            >
                {row.requestCount}
            </td>
            <td>
                <div
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "4px",
                    }}
                >
                    <div
                        style={{
                            width: "80px",
                            height: "4px",
                            background: "var(--s3)",
                            borderRadius: "2px",
                            overflow: "hidden",
                        }}
                    >
                        <div
                            style={{
                                height: "100%",
                                width: `${Math.min(pct, 100)}%`,
                                background: barColor,
                                borderRadius: "2px",
                            }}
                        />
                    </div>
                    <span
                        style={{
                            fontFamily: "var(--mono)",
                            fontSize: "11px",
                            color: "var(--t2)",
                        }}
                    >
                        {row.scheduledCount} / {total}
                    </span>
                </div>
            </td>
        </tr>
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
                background: isDiamond
                    ? "rgba(155,114,245,0.12)"
                    : "rgba(46,201,126,0.1)",
                color: isDiamond ? "var(--purple)" : "var(--green)",
                border: `1px solid ${isDiamond ? "rgba(155,114,245,0.25)" : "rgba(46,201,126,0.3)"}`,
                whiteSpace: "nowrap",
            }}
        >
            {isDiamond ? "◆ Diamond" : "● Standard"}
        </span>
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
        <div
            style={{
                position: "fixed",
                inset: 0,
                zIndex: 50,
                background: "rgba(0,0,0,0.45)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "16px",
            }}
        >
            <div
                style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r-lg)",
                    padding: "28px 32px",
                    width: "100%",
                    maxWidth: "460px",
                }}
            >
                <div
                    style={{
                        fontFamily: "var(--display)",
                        fontSize: "16px",
                        fontWeight: 700,
                        marginBottom: "10px",
                    }}
                >
                    Run Scheduling Engine?
                </div>
                <p
                    style={{
                        fontSize: "13px",
                        color: "var(--t2)",
                        lineHeight: "1.55",
                        margin: "0 0 20px",
                    }}
                >
                    This will replace all un-pushed meetings for{" "}
                    <strong style={{ color: "var(--text)" }}>{eventCode}</strong>{" "}
                    with fresh engine output. Meetings already pushed to Cvent are
                    preserved and count against per-sponsor caps.
                </p>

                {error && (
                    <div
                        style={{
                            marginBottom: "16px",
                            padding: "10px 14px",
                            background: "rgba(232,57,30,0.08)",
                            border: "1px solid var(--red-b, rgba(232,57,30,0.3))",
                            borderRadius: "var(--r)",
                            fontSize: "12px",
                            color: "var(--red, #e8391e)",
                        }}
                    >
                        {error}
                    </div>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                    <button
                        className="adm-btn"
                        onClick={onCancel}
                        disabled={isPending}
                    >
                        Cancel
                    </button>
                    <button
                        className="adm-btn adm-btn-primary"
                        onClick={onConfirm}
                        disabled={isPending}
                    >
                        {isPending ? "Running…" : "Run Engine"}
                    </button>
                </div>
            </div>
        </div>
    );
}
