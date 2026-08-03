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
import { fmtDateTime } from "@/lib/format";
import { SortableHeaders } from "../_components/SortableHeaders";
import { TablePagination } from "../_components/TablePagination";
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
// pushes every change to the URL, which re-runs the server query. The header
// and footer come from the shared SortableHeaders / TablePagination
// components; the inline create/edit/delete UI is the same pattern as
// /admin/users.
// ---------------------------------------------------------------------------

type Props = {
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

export default function RequestsTable({
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
        q?: string;
        sort?: RequestSortField;
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
    // Resync when the URL changes externally (back/forward, event switch).
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
        <div className="adm-page">
            <div className="adm-page-head">
                <h1 className="adm-page-title">Meeting requests</h1>
                <button
                    type="button"
                    className="adm-new-btn adm-new-btn-primary"
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

            <div className="adm-toolbar">
                <input
                    type="search"
                    className="adm-input adm-search"
                    placeholder="Search requester or target name / company…"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                />
            </div>

            <table className="adm-table">
                <SortableHeaders table={table} />
                <tbody>
                    {creating && (
                        <>
                            <tr className="adm-row adm-row-new">
                                <td>
                                    <input
                                        type="text"
                                        className="adm-input"
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
                                        className="adm-input"
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
                                        className="adm-input"
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
                                <td className="adm-actions-cell">
                                    <div className="adm-actions-inner">
                                        <button
                                            type="button"
                                            className="adm-btn adm-btn-primary"
                                            onClick={saveCreate}
                                            disabled={pending}
                                        >
                                            Save
                                        </button>
                                        <button
                                            type="button"
                                            className="adm-btn"
                                            onClick={cancelCreate}
                                            disabled={pending}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </td>
                            </tr>
                            {rowError?.id === "new" && (
                                <tr className="adm-row-error">
                                    <td colSpan={COL_COUNT}>
                                        {rowError.message}
                                    </td>
                                </tr>
                            )}
                        </>
                    )}

                    {data.rows.length === 0 && !creating ? (
                        <tr>
                            <td colSpan={COL_COUNT} className="adm-empty">
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

            <TablePagination
                table={table}
                total={data.total}
                noun="request"
                busy={pending}
            />
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
            <tr className="adm-row">
                <td>
                    <div className="adm-party-name">{r.requesterName}</div>
                    {r.requesterCompany && (
                        <div className="adm-party-company">
                            {r.requesterCompany}
                        </div>
                    )}
                </td>
                <td>
                    <div className="adm-party-name">{r.targetName}</div>
                    {r.targetCompany && (
                        <div className="adm-party-company">
                            {r.targetCompany}
                        </div>
                    )}
                </td>
                <td>
                    {isEditing ? (
                        <select
                            className="adm-input"
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
                <td className="adm-actions-cell">
                    <div className="adm-actions-inner">
                        {isEditing ? (
                            <>
                                <button
                                    type="button"
                                    className="adm-btn adm-btn-primary"
                                    onClick={saveEdit}
                                    disabled={pending}
                                >
                                    Save
                                </button>
                                <button
                                    type="button"
                                    className="adm-btn"
                                    onClick={cancelEdit}
                                    disabled={pending}
                                >
                                    Cancel
                                </button>
                            </>
                        ) : isConfirming ? (
                            <>
                                <span className="adm-confirm-label">
                                    Delete?
                                </span>
                                <button
                                    type="button"
                                    className="adm-btn adm-btn-danger"
                                    onClick={confirmDelete}
                                    disabled={pending}
                                >
                                    Yes
                                </button>
                                <button
                                    type="button"
                                    className="adm-btn"
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
                                    className="adm-btn"
                                    onClick={beginEdit}
                                    disabled={pending}
                                >
                                    Edit
                                </button>
                                <button
                                    type="button"
                                    className="adm-btn adm-btn-danger"
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
                <tr className="adm-row-error">
                    <td colSpan={COL_COUNT}>{rowError.message}</td>
                </tr>
            )}
        </>
    );
}
