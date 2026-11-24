"use client";

import { useEffect, useMemo, useState } from "react";
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
import type {
    DelegateRow,
    DelegateSortField,
    DelegatesPage,
} from "@/lib/admin/delegates";
import { SortableHeaders } from "../_components/SortableHeaders";
import { TablePagination } from "../_components/TablePagination";

// ---------------------------------------------------------------------------
// DelegatesTable is the read-only admin table of catalog delegates.
//
// Search (q), sort and page all live in the URL, and the server renders one
// page at a time. TanStack Table runs in manual mode, the same as
// /admin/requests. It owns the header sort UI and pagination controls and
// pushes every change to the URL.
// ---------------------------------------------------------------------------

type Props = {
    selectedEvent: string | null;
    query: string;
    sortField: DelegateSortField;
    sortDir: "asc" | "desc";
    data: DelegatesPage;
};

const COL_COUNT = 3;

/**
 * Renders the searchable, sortable delegates table.
 *
 * @param {Props} props - The active event, view state and page of rows.
 * @returns {JSX.Element} The table page.
 */
export default function DelegatesTable({
    selectedEvent,
    query,
    sortField,
    sortDir,
    data,
}: Props) {
    const router = useRouter();
    const pathname = usePathname();

    /**
     * Builds a table URL by merging `overrides` onto the current view state.
     * Anything not overridden carries through, so each control only changes its own param.
     *
     * @param {{ q?: string; sort?: DelegateSortField; dir?: "asc" | "desc"; page?: number }} overrides - Params to change.
     * @returns {string} The new URL.
     */
    function hrefWith(overrides: {
        q?: string;
        sort?: DelegateSortField;
        dir?: "asc" | "desc";
        page?: number;
    }): string {
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

    // ── Live search → URL ────────────────────────────────────────────────────
    const [searchInput, setSearchInput] = useState(query);
    // Resync when the URL changes from outside, such as back/forward.
    useEffect(() => setSearchInput(query), [query]);
    const [debouncedSearch] = useDebounce(searchInput, 300);
    useEffect(() => {
        if (debouncedSearch.trim() === query.trim()) return;
        router.push(hrefWith({ q: debouncedSearch, page: 1 }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedSearch]);

    // ── TanStack table (manual sorting + pagination, controlled by the URL) ──
    const sorting = useMemo<SortingState>(
        () => [{ id: sortField, desc: sortDir === "desc" }],
        [sortField, sortDir],
    );
    const pagination = useMemo<PaginationState>(
        () => ({ pageIndex: data.page - 1, pageSize: data.pageSize }),
        [data.page, data.pageSize],
    );

    const columns = useMemo<ColumnDef<DelegateRow>[]>(
        () => [
            { id: "name", header: "Name" },
            { id: "company", header: "Company" },
            { id: "email", header: "Email" },
        ],
        [],
    );

    const onSortingChange: OnChangeFn<SortingState> = (updater) => {
        const next = typeof updater === "function" ? updater(sorting) : updater;
        const s = next[0] ?? { id: sortField, desc: true };
        router.push(
            hrefWith({
                sort: s.id as DelegateSortField,
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

    // ── Render ─────────────────────────────────────────────────────────────────

    return (
        <div className="adm-page">
            <div className="adm-page-head">
                <h1 className="adm-page-title">Delegates</h1>
            </div>

            <p className="adm-help-note">
                This list shows the delegates that sponsors see for this event
                on the frontend.
            </p>

            <div className="adm-toolbar">
                <input
                    type="search"
                    className="adm-input adm-search"
                    placeholder="Search name, company or email…"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                />
            </div>

            <table className="adm-table">
                <SortableHeaders table={table} />
                <tbody>
                    {data.rows.length === 0 ? (
                        <tr>
                            <td colSpan={COL_COUNT} className="adm-empty">
                                {!selectedEvent
                                    ? "No events found. Click “+ New Event” under the event picker to add one."
                                    : query
                                      ? "No delegates match your search."
                                      : "No delegates for this event."}
                            </td>
                        </tr>
                    ) : (
                        data.rows.map((d) => (
                            <tr key={d.salesforceId} className="adm-row">
                                <td>{d.name || "—"}</td>
                                <td>{d.company || "—"}</td>
                                <td>{d.email || "—"}</td>
                            </tr>
                        ))
                    )}
                </tbody>
            </table>

            <TablePagination
                table={table}
                total={data.total}
                noun="delegate"
            />
        </div>
    );
}
