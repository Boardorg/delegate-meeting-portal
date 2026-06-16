"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
    flexRender,
    getCoreRowModel,
    useReactTable,
    type ColumnDef,
    type OnChangeFn,
    type PaginationState,
    type SortingState,
} from "@tanstack/react-table";
import {
    createRequest,
    updateRequest,
    deleteRequest,
    type RequestRow,
    type RequestsPage,
    type RequestSortField,
} from "./actions";

// ---------------------------------------------------------------------------
// RequestsTable — admin table for meeting requests.
//
// Event, search (q), sort, and page all live in the URL; the server renders
// one page at a time. TanStack Table runs in manual mode (manualSorting +
// manualPagination): it owns the header sort UI and pagination controls and
// pushes every change to the URL, which re-runs the server query. The inline
// create/edit/delete UI is the same pattern as /admin/users.
// ---------------------------------------------------------------------------

type Props = {
    eventCodes: string[];
    selectedEvent: string | null;
    query: string;
    sortField: RequestSortField;
    sortDir: "asc" | "desc";
    data: RequestsPage;
};

// Form state for the new-request row. Ids are Salesforce attendee ids.
type NewDraft = {
    requesterId: string;
    targetId: string;
    rank: number;
};

const RANKS = [1, 2, 3, 4, 5];
const COL_COUNT = 6;

function emptyDraft(): NewDraft {
    return { requesterId: "", targetId: "", rank: 5 };
}

/**
 * Formats a timestamp as `m/d/yyyy, h:mm AM`.
 */
function fmtDateTime(d: Date): string {
    return d.toLocaleString("en-US", {
        month: "numeric",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

/**
 * Debounces a value so the live search navigates only after typing pauses.
 *
 * @param {T} value - The value to debounce.
 * @param {number} delay - Quiet period in ms.
 * @returns {T} The debounced value.
 */
function useDebounced<T>(value: T, delay: number): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(t);
    }, [value, delay]);
    return debounced;
}

export default function RequestsTable({
    eventCodes,
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
     * Anything not overridden carries through, so each control only changes
     * its own param.
     */
    function hrefWith(overrides: {
        event?: string | null;
        q?: string;
        sort?: RequestSortField;
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

    // ── Live search → URL ────────────────────────────────────────────────────
    const [searchInput, setSearchInput] = useState(query);
    // Resync when the URL changes externally (back/forward, event switch).
    useEffect(() => setSearchInput(query), [query]);
    const debouncedSearch = useDebounced(searchInput, 300);
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

    const columns = useMemo<ColumnDef<RequestRow>[]>(
        () => [
            { id: "requesterName", header: "Requester" },
            { id: "targetName", header: "Target" },
            { id: "rank", header: "Interest level" },
            { id: "createdAt", header: "Created" },
            { id: "updatedAt", header: "Updated" },
            { id: "actions", header: "Actions", enableSorting: false },
        ],
        [],
    );

    const onSortingChange: OnChangeFn<SortingState> = (updater) => {
        const next = typeof updater === "function" ? updater(sorting) : updater;
        const s = next[0] ?? { id: sortField, desc: true };
        router.push(
            hrefWith({
                sort: s.id as RequestSortField,
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

    // ── Edit / delete / create state ─────────────────────────────────────────
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editRank, setEditRank] = useState<number>(5);
    const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
    const [creating, setCreating] = useState(false);
    const [newDraft, setNewDraft] = useState<NewDraft>(emptyDraft());
    const [rowError, setRowError] = useState<{
        id: number | "new";
        message: string;
    } | null>(null);

    const [pending, startTransition] = useTransition();

    // ── Event dropdown ───────────────────────────────────────────────────────

    function changeEvent(code: string) {
        // New event → reset to page 1; search carries over.
        router.push(hrefWith({ event: code, page: 1 }));
    }

    // ── Edit handlers ─────────────────────────────────────────────────────────

    function beginEdit(r: RequestRow) {
        setEditingId(r.id);
        setEditRank(r.rank);
        setConfirmDeleteId(null);
        setRowError(null);
    }

    function cancelEdit() {
        setEditingId(null);
        setRowError(null);
    }

    function saveEdit() {
        if (editingId == null) return;
        const id = editingId;
        startTransition(async () => {
            const res = await updateRequest(id, { rank: editRank });
            if (res.ok) {
                setEditingId(null);
                setRowError(null);
            } else {
                setRowError({ id, message: res.error });
            }
        });
    }

    // ── Create handlers ───────────────────────────────────────────────────────

    function beginCreate() {
        setCreating(true);
        setNewDraft(emptyDraft());
        setEditingId(null);
        setRowError(null);
    }

    function cancelCreate() {
        setCreating(false);
        setNewDraft(emptyDraft());
        setRowError(null);
    }

    function saveCreate() {
        if (!selectedEvent) return;
        const draft = newDraft;
        startTransition(async () => {
            const res = await createRequest({
                requesterId: draft.requesterId,
                targetId: draft.targetId,
                rank: draft.rank,
                eventCode: selectedEvent,
            });
            if (res.ok) {
                setCreating(false);
                setNewDraft(emptyDraft());
                setRowError(null);
            } else {
                setRowError({ id: "new", message: res.error });
            }
        });
    }

    // ── Delete handlers ───────────────────────────────────────────────────────

    function confirmDelete(id: number) {
        startTransition(async () => {
            const res = await deleteRequest(id);
            if (res.ok) {
                setConfirmDeleteId(null);
                setRowError(null);
            } else {
                setRowError({ id, message: res.error });
            }
        });
    }

    // ── Render ─────────────────────────────────────────────────────────────────

    return (
        <div className="users-page">
            <div className="users-page-head">
                <h1 className="users-page-title">Meeting requests</h1>
                <button
                    type="button"
                    className="users-new-btn"
                    onClick={beginCreate}
                    disabled={creating || pending || !selectedEvent}
                    title={
                        selectedEvent
                            ? undefined
                            : "No event to add a request to yet"
                    }
                >
                    + New request
                </button>
            </div>

            <div className="requests-toolbar">
                <label className="requests-field">
                    <span className="requests-field-label">Event</span>
                    <select
                        className="users-input requests-select"
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
                    className="users-input requests-search"
                    placeholder="Search requester or target..."
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                />
            </div>

            <table className="users-table">
                <thead>
                    {table.getHeaderGroups().map((hg) => (
                        <tr key={hg.id}>
                            {hg.headers.map((header) => {
                                const canSort = header.column.getCanSort();
                                const sorted = header.column.getIsSorted();
                                return (
                                    <th
                                        key={header.id}
                                        className={
                                            header.column.id === "actions"
                                                ? "users-actions-col"
                                                : undefined
                                        }
                                    >
                                        {canSort ? (
                                            <button
                                                type="button"
                                                className="requests-sort-btn"
                                                onClick={header.column.getToggleSortingHandler()}
                                            >
                                                {flexRender(
                                                    header.column.columnDef
                                                        .header,
                                                    header.getContext(),
                                                )}
                                                <span className="requests-sort-ind">
                                                    {sorted === "asc"
                                                        ? "↑"
                                                        : sorted === "desc"
                                                          ? "↓"
                                                          : ""}
                                                </span>
                                            </button>
                                        ) : (
                                            flexRender(
                                                header.column.columnDef.header,
                                                header.getContext(),
                                            )
                                        )}
                                    </th>
                                );
                            })}
                        </tr>
                    ))}
                </thead>
                <tbody>
                    {creating && (
                        <>
                            <tr className="users-row users-row-new">
                                <td>
                                    <input
                                        type="text"
                                        className="users-input"
                                        value={newDraft.requesterId}
                                        onChange={(e) =>
                                            setNewDraft({
                                                ...newDraft,
                                                requesterId: e.target.value,
                                            })
                                        }
                                        disabled={pending}
                                        placeholder="Requester Salesforce ID"
                                    />
                                </td>
                                <td>
                                    <input
                                        type="text"
                                        className="users-input"
                                        value={newDraft.targetId}
                                        onChange={(e) =>
                                            setNewDraft({
                                                ...newDraft,
                                                targetId: e.target.value,
                                            })
                                        }
                                        disabled={pending}
                                        placeholder="Target Salesforce ID"
                                    />
                                </td>
                                <td>
                                    <select
                                        className="users-input"
                                        value={newDraft.rank}
                                        onChange={(e) =>
                                            setNewDraft({
                                                ...newDraft,
                                                rank: Number(e.target.value),
                                            })
                                        }
                                        disabled={pending}
                                    >
                                        {RANKS.map((n) => (
                                            <option key={n} value={n}>
                                                {n}
                                            </option>
                                        ))}
                                    </select>
                                </td>
                                <td>—</td>
                                <td>—</td>
                                <td className="users-actions-cell">
                                    <div className="users-actions-inner">
                                        <button
                                            type="button"
                                            className="users-btn users-btn-primary"
                                            onClick={saveCreate}
                                            disabled={pending}
                                        >
                                            Save
                                        </button>
                                        <button
                                            type="button"
                                            className="users-btn"
                                            onClick={cancelCreate}
                                            disabled={pending}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </td>
                            </tr>
                            {rowError?.id === "new" && (
                                <tr className="users-row-error">
                                    <td colSpan={COL_COUNT}>
                                        {rowError.message}
                                    </td>
                                </tr>
                            )}
                        </>
                    )}

                    {data.rows.length === 0 && !creating ? (
                        <tr>
                            <td colSpan={COL_COUNT} className="users-empty">
                                {query
                                    ? "No requests match your search."
                                    : "No requests for this event."}
                            </td>
                        </tr>
                    ) : (
                        data.rows.map((r) => (
                            <RowFragment
                                key={r.id}
                                r={r}
                                isEditing={editingId === r.id}
                                isConfirming={confirmDeleteId === r.id}
                                pending={pending}
                                rowError={rowError}
                                editRank={editRank}
                                setEditRank={setEditRank}
                                beginEdit={() => beginEdit(r)}
                                cancelEdit={cancelEdit}
                                saveEdit={saveEdit}
                                askDelete={() => {
                                    setConfirmDeleteId(r.id);
                                    setRowError(null);
                                }}
                                cancelDelete={() => setConfirmDeleteId(null)}
                                confirmDelete={() => confirmDelete(r.id)}
                            />
                        ))
                    )}
                </tbody>
            </table>

            <div className="requests-pagination">
                <span className="requests-page-info">
                    {data.total} request{data.total !== 1 ? "s" : ""} · Page{" "}
                    {data.page} of {data.pageCount}
                </span>
                <div className="requests-page-btns">
                    <button
                        type="button"
                        className="users-btn"
                        onClick={() => table.previousPage()}
                        disabled={!table.getCanPreviousPage() || pending}
                    >
                        ← Prev
                    </button>
                    <button
                        type="button"
                        className="users-btn"
                        onClick={() => table.nextPage()}
                        disabled={!table.getCanNextPage() || pending}
                    >
                        Next →
                    </button>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// RowFragment — a view row, an edit row (interest level only), or a
// confirm-delete row, plus an inline error row for this request.
// ---------------------------------------------------------------------------

type RowFragmentProps = {
    r: RequestRow;
    isEditing: boolean;
    isConfirming: boolean;
    pending: boolean;
    rowError: { id: number | "new"; message: string } | null;
    editRank: number;
    setEditRank: (n: number) => void;
    beginEdit: () => void;
    cancelEdit: () => void;
    saveEdit: () => void;
    askDelete: () => void;
    cancelDelete: () => void;
    confirmDelete: () => void;
};

function RowFragment(props: RowFragmentProps) {
    const {
        r,
        isEditing,
        isConfirming,
        pending,
        rowError,
        editRank,
        setEditRank,
        beginEdit,
        cancelEdit,
        saveEdit,
        askDelete,
        cancelDelete,
        confirmDelete,
    } = props;

    return (
        <>
            <tr className="users-row">
                <td>
                    <div className="req-party-name">{r.requesterName}</div>
                    {r.requesterCompany && (
                        <div className="req-party-company">
                            {r.requesterCompany}
                        </div>
                    )}
                </td>
                <td>
                    <div className="req-party-name">{r.targetName}</div>
                    {r.targetCompany && (
                        <div className="req-party-company">
                            {r.targetCompany}
                        </div>
                    )}
                </td>
                <td>
                    {isEditing ? (
                        <select
                            className="users-input"
                            value={editRank}
                            onChange={(e) =>
                                setEditRank(Number(e.target.value))
                            }
                            disabled={pending}
                        >
                            {RANKS.map((n) => (
                                <option key={n} value={n}>
                                    {n}
                                </option>
                            ))}
                        </select>
                    ) : (
                        r.rank
                    )}
                </td>
                <td>{fmtDateTime(r.createdAt)}</td>
                <td>{fmtDateTime(r.updatedAt)}</td>
                <td className="users-actions-cell">
                    <div className="users-actions-inner">
                        {isEditing ? (
                            <>
                                <button
                                    type="button"
                                    className="users-btn users-btn-primary"
                                    onClick={saveEdit}
                                    disabled={pending}
                                >
                                    Save
                                </button>
                                <button
                                    type="button"
                                    className="users-btn"
                                    onClick={cancelEdit}
                                    disabled={pending}
                                >
                                    Cancel
                                </button>
                            </>
                        ) : isConfirming ? (
                            <>
                                <span className="users-confirm-label">
                                    Delete?
                                </span>
                                <button
                                    type="button"
                                    className="users-btn users-btn-danger"
                                    onClick={confirmDelete}
                                    disabled={pending}
                                >
                                    Yes
                                </button>
                                <button
                                    type="button"
                                    className="users-btn"
                                    onClick={cancelDelete}
                                    disabled={pending}
                                >
                                    No
                                </button>
                            </>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    className="users-btn"
                                    onClick={beginEdit}
                                    disabled={pending}
                                >
                                    Edit
                                </button>
                                <button
                                    type="button"
                                    className="users-btn users-btn-danger"
                                    onClick={askDelete}
                                    disabled={pending}
                                >
                                    Delete
                                </button>
                            </>
                        )}
                    </div>
                </td>
            </tr>
            {rowError?.id === r.id && (
                <tr className="users-row-error">
                    <td colSpan={COL_COUNT}>{rowError.message}</td>
                </tr>
            )}
        </>
    );
}
