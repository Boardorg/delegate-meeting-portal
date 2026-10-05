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
import Select, { type StylesConfig } from "react-select";
import { fmtDateTime } from "@/lib/format";
import { SortableHeaders } from "../_components/SortableHeaders";
import { TablePagination } from "../_components/TablePagination";
import {
    createRequest,
    updateRequest,
    deleteRequest,
    listRequestParties,
    type RequestRow,
    type RequestsPage,
    type RequestSortField,
    type RequestPartyOption,
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

// ---------------------------------------------------------------------------
// PartySelect — searchable name picker (react-select) for the requester/target
// fields. Displays company + delegate names and reports the selected party id,
// so admins never type a raw Salesforce/Account id. Options are loaded once per
// event and filtered client-side.
// ---------------------------------------------------------------------------

/** A react-select option wrapping one selectable party. */
type PartyOption = {
    value: string; // party id (company Account id or delegate salesforceId)
    label: string; // display name
    company: string; // employer (== label for companies)
    kind: RequestPartyOption["kind"];
};

/** Maps a party from the server action to a react-select option. */
function toPartyOption(p: RequestPartyOption): PartyOption {
    return { value: p.id, label: p.name, company: p.company, kind: p.kind };
}

// react-select styling tuned to match .adm-input (see backend.css): same
// border, radius, surface, and 12px body font. CSS vars resolve at render, so
// the picker tracks the admin theme like the native inputs it replaces.
const partySelectStyles: StylesConfig<PartyOption, false> = {
    control: (base, state) => ({
        ...base,
        minHeight: 30,
        fontSize: 12,
        fontFamily: "var(--body)",
        backgroundColor: "var(--surface)",
        borderColor: state.isFocused ? "var(--border-up)" : "var(--border)",
        borderRadius: "var(--r)",
        boxShadow: "none",
        "&:hover": { borderColor: "var(--border-up)" },
    }),
    valueContainer: (base) => ({ ...base, padding: "0 8px" }),
    input: (base) => ({ ...base, margin: 0, padding: 0, color: "var(--text)" }),
    placeholder: (base) => ({ ...base, color: "var(--t3)" }),
    singleValue: (base) => ({ ...base, color: "var(--text)" }),
    dropdownIndicator: (base) => ({ ...base, padding: 4 }),
    clearIndicator: (base) => ({ ...base, padding: 4 }),
    menu: (base) => ({
        ...base,
        fontSize: 12,
        backgroundColor: "var(--surface)",
        border: "1px solid var(--border)",
    }),
    // The menu is portaled to <body> so the table's overflow can't clip it.
    menuPortal: (base) => ({ ...base, zIndex: 9999 }),
    option: (base, state) => ({
        ...base,
        color: "var(--text)",
        backgroundColor: state.isFocused ? "var(--s2)" : "transparent",
        cursor: "pointer",
        ":active": { backgroundColor: "var(--s2)" },
    }),
};

function PartySelect({
    parties,
    value,
    onChange,
    placeholder,
    disabled,
    instanceId,
}: {
    /** Loaded options, or null while still loading. */
    parties: PartyOption[] | null;
    /** Currently selected party id ("" for none). */
    value: string;
    onChange: (id: string) => void;
    placeholder: string;
    disabled: boolean;
    /** Stable id so SSR/CSR markup matches (avoids hydration id churn). */
    instanceId: string;
}) {
    const options = parties ?? [];
    const selected = options.find((o) => o.value === value) ?? null;
    return (
        <Select<PartyOption>
            instanceId={instanceId}
            classNamePrefix="adm-party-select"
            options={options}
            value={selected}
            onChange={(o) => onChange(o?.value ?? "")}
            isDisabled={disabled}
            isLoading={parties === null}
            isClearable
            placeholder={placeholder}
            styles={partySelectStyles}
            menuPortalTarget={
                typeof document !== "undefined" ? document.body : undefined
            }
            menuPosition="fixed"
            // Match on the name AND the employer company so searching either finds
            // the party (react-select otherwise only filters on the label).
            filterOption={(option, input) => {
                if (!input) return true;
                const q = input.toLowerCase();
                const o = option.data;
                return (
                    o.label.toLowerCase().includes(q) ||
                    o.company.toLowerCase().includes(q)
                );
            }}
            // In the dropdown, tag each option with its kind (companies) or its
            // employer (delegates) so same-named parties are distinguishable.
            formatOptionLabel={(o, meta) =>
                meta.context === "menu" ? (
                    <span>
                        {o.label}
                        <span className="adm-party-select-sub">
                            {o.kind === "company" ? "Company" : o.company}
                        </span>
                    </span>
                ) : (
                    o.label
                )
            }
            noOptionsMessage={() => "No matching companies or delegates"}
        />
    );
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

    // ── Party pick-list (requester / target options) ─────────────────────────
    // Loaded once per event and filtered client-side by react-select. `null`
    // means "not loaded yet" (drives the picker's loading state).
    const [parties, setParties] = useState<PartyOption[] | null>(null);

    // Reset when the active event changes so we never show a stale event's
    // companies/delegates.
    useEffect(() => setParties(null), [selectedEvent]);

    // Load the parties lazily the first time the create row is opened for an
    // event. The `active` guard drops a stale response if the event changes
    // mid-fetch.
    useEffect(() => {
        if (!creating || !selectedEvent || parties !== null) return;
        let active = true;
        listRequestParties(selectedEvent)
            .then((ps) => {
                if (active) setParties(ps.map(toPartyOption));
            })
            .catch(() => {
                if (active) setParties([]);
            });
        return () => {
            active = false;
        };
    }, [creating, selectedEvent, parties]);

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
                                    <PartySelect
                                        instanceId="new-request-requester"
                                        parties={parties}
                                        value={newDraft.requesterId}
                                        onChange={(id) =>
                                            setNewDraft({
                                                ...newDraft,
                                                requesterId: id,
                                            })
                                        }
                                        disabled={pending}
                                        placeholder="Search companies & delegates…"
                                    />
                                </td>
                                <td>
                                    <PartySelect
                                        instanceId="new-request-target"
                                        parties={parties}
                                        value={newDraft.targetId}
                                        onChange={(id) =>
                                            setNewDraft({
                                                ...newDraft,
                                                targetId: id,
                                            })
                                        }
                                        disabled={pending}
                                        placeholder="Search companies & delegates…"
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
                    {/* The requester is a company, so its name already carries
                        the company identity — the company subtitle is redundant
                        here and is intentionally omitted. */}
                    <div className="adm-party-name">{r.requesterName}</div>
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
