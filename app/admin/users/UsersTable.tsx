"use client";

import { useMemo, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
    getCoreRowModel,
    useReactTable,
    type ColumnDef,
    type OnChangeFn,
    type PaginationState,
} from "@tanstack/react-table";
import type { User } from "@/lib/db/schema";
import { fmtDate } from "@/lib/format";
import { SortableHeaders } from "../_components/SortableHeaders";
import { TablePagination } from "../_components/TablePagination";
import {
    createUser,
    updateUser,
    deleteUser,
    type UsersPage,
} from "./actions";

// ---------------------------------------------------------------------------
// UsersTable — interactive admin table.
//
// Server pieces (list/create/update/delete) live in ./actions.ts; this
// component owns the per-row UI state (which row is editing, which row is
// pending deletion confirmation, whether the new-user row is open).
//
// Pagination is URL-driven: TanStack runs in manual mode and pushes the new
// page to the query string, which re-runs the page's server query. The
// header and footer come from the shared SortableHeaders / TablePagination
// components (also used by /admin/requests).
// ---------------------------------------------------------------------------

type Props = {
    data: UsersPage;
};

// Local form state for both the inline edit form and the new-user row. Kept
// as one shape with email/username nullable so a single set of inputs can
// drive both flows.
type EditDraft = {
    email: string;
    phone: string;
    username: string;
    role: "admin" | "user" | "sponsor";
};

const COL_COUNT = 7;

/**
 * Builds an EditDraft pre-filled from a row. Nulls become empty strings so
 * the inputs render controlled.
 */
function draftFromUser(u: User): EditDraft {
    return {
        email: u.email ?? "",
        phone: u.phone,
        username: u.username ?? "",
        role: u.role,
    };
}

/**
 * Builds an empty EditDraft for the new-user row.
 */
function emptyDraft(): EditDraft {
    return { email: "", phone: "", username: "", role: "admin" };
}

export default function UsersTable({ data }: Props) {
    const router = useRouter();
    const pathname = usePathname();

    // ── Edit state ─────────────────────────────────────────────────────────
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editDraft, setEditDraft] = useState<EditDraft | null>(null);

    // ── Delete-confirm state ───────────────────────────────────────────────
    const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

    // ── New-user row state ─────────────────────────────────────────────────
    const [creating, setCreating] = useState(false);
    const [newDraft, setNewDraft] = useState<EditDraft>(emptyDraft());

    // ── Per-row error message (most-recent failure for that row) ───────────
    const [rowError, setRowError] = useState<{
        id: number | "new";
        message: string;
    } | null>(null);

    // useTransition makes the server-action calls non-blocking for the UI
    // and exposes a `pending` flag for disabling inputs / showing spinners.
    const [pending, startTransition] = useTransition();

    /** Builds a table URL carrying the page (the table's only URL state). */
    function hrefWith(overrides: { page?: number }): string {
        const params = new URLSearchParams();
        const page = overrides.page ?? data.page;
        if (page > 1) params.set("page", String(page));
        const qs = params.toString();
        return qs ? `${pathname}?${qs}` : pathname;
    }

    // ── TanStack table (header rendering + manual pagination) ──────────────
    const columns = useMemo<ColumnDef<User>[]>(
        () => [
            { id: "email", header: "Email" },
            { id: "phone", header: "Phone" },
            { id: "username", header: "Username" },
            { id: "role", header: "Role" },
            { id: "created", header: "Created" },
            { id: "lastLogin", header: "Last login" },
            { id: "actions", header: "Actions" },
        ],
        [],
    );

    const pagination = useMemo<PaginationState>(
        () => ({ pageIndex: data.page - 1, pageSize: data.pageSize }),
        [data.page, data.pageSize],
    );

    const onPaginationChange: OnChangeFn<PaginationState> = (updater) => {
        const next =
            typeof updater === "function" ? updater(pagination) : updater;
        router.push(hrefWith({ page: next.pageIndex + 1 }));
    };

    const table = useReactTable({
        data: data.rows,
        columns,
        getCoreRowModel: getCoreRowModel(),
        manualPagination: true,
        pageCount: data.pageCount,
        state: { pagination },
        onPaginationChange,
    });

    // ── Handlers ───────────────────────────────────────────────────────────

    function beginEdit(u: User) {
        setEditingId(u.id);
        setEditDraft(draftFromUser(u));
        setConfirmDeleteId(null);
        setRowError(null);
    }

    function cancelEdit() {
        setEditingId(null);
        setEditDraft(null);
        setRowError(null);
    }

    function saveEdit() {
        if (editingId == null || !editDraft) return;
        const id = editingId;
        const draft = editDraft;
        startTransition(async () => {
            const res = await updateUser(id, {
                email: draft.email,
                phone: draft.phone,
                username: draft.username,
                role: draft.role,
            });
            if (res.ok) {
                setEditingId(null);
                setEditDraft(null);
                setRowError(null);
            } else {
                setRowError({ id, message: res.error });
            }
        });
    }

    function beginCreate() {
        setCreating(true);
        setNewDraft(emptyDraft());
        setEditingId(null);
        setEditDraft(null);
        setRowError(null);
    }

    function cancelCreate() {
        setCreating(false);
        setNewDraft(emptyDraft());
        setRowError(null);
    }

    function saveCreate() {
        const draft = newDraft;
        startTransition(async () => {
            const res = await createUser({
                email: draft.email,
                phone: draft.phone,
                username: draft.username,
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

    function confirmDelete(id: number) {
        startTransition(async () => {
            const res = await deleteUser(id);
            if (res.ok) {
                setConfirmDeleteId(null);
                setRowError(null);
            } else {
                setRowError({ id, message: res.error });
            }
        });
    }

    // ── Render helpers ─────────────────────────────────────────────────────

    /**
     * Renders the four editable cells (email, phone, username, role) shared
     * by both edit-mode rows and the new-user row.
     */
    function renderEditCells(
        draft: EditDraft,
        setDraft: (d: EditDraft) => void,
        phoneRequired: boolean,
    ) {
        return (
            <>
                <td>
                    <input
                        type="email"
                        className="adm-input"
                        value={draft.email}
                        onChange={(e) =>
                            setDraft({ ...draft, email: e.target.value })
                        }
                        disabled={pending}
                        placeholder="email@example.com"
                    />
                </td>
                <td>
                    <input
                        type="tel"
                        className="adm-input"
                        value={draft.phone}
                        onChange={(e) =>
                            setDraft({ ...draft, phone: e.target.value })
                        }
                        disabled={pending}
                        required={phoneRequired}
                        placeholder="+1 555 555 0123"
                    />
                </td>
                <td>
                    <input
                        type="text"
                        className="adm-input"
                        value={draft.username}
                        onChange={(e) =>
                            setDraft({ ...draft, username: e.target.value })
                        }
                        disabled={pending}
                        placeholder="username"
                    />
                </td>
                <td>
                    <select
                        className="adm-input"
                        value={draft.role}
                        onChange={(e) =>
                            setDraft({
                                ...draft,
                                role: e.target.value as EditDraft["role"],
                            })
                        }
                        disabled={pending}
                    >
                        <option value="admin">admin</option>
                        <option value="user">user</option>
                        <option value="sponsor">sponsor</option>
                    </select>
                </td>
            </>
        );
    }

    // ── JSX ────────────────────────────────────────────────────────────────

    return (
        <div className="adm-page">
            <div className="adm-page-head">
                <h1 className="adm-page-title">Users</h1>
                <button
                    type="button"
                    className="adm-new-btn adm-new-btn-primary"
                    onClick={beginCreate}
                    disabled={creating || pending}
                >
                    + New user
                </button>
            </div>

            <table className="adm-table">
                <SortableHeaders table={table} />
                <tbody>
                    {creating && (
                        <>
                            <tr className="adm-row adm-row-new">
                                {renderEditCells(newDraft, setNewDraft, true)}
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
                                No users yet.
                            </td>
                        </tr>
                    ) : (
                        data.rows.map((u) => {
                            const isEditing = editingId === u.id;
                            const isConfirming = confirmDeleteId === u.id;
                            return (
                                <RowFragment
                                    key={u.id}
                                    u={u}
                                    isEditing={isEditing}
                                    isConfirming={isConfirming}
                                    pending={pending}
                                    rowError={rowError}
                                    editDraft={editDraft}
                                    setEditDraft={setEditDraft}
                                    renderEditCells={renderEditCells}
                                    beginEdit={() => beginEdit(u)}
                                    cancelEdit={cancelEdit}
                                    saveEdit={saveEdit}
                                    askDelete={() => {
                                        setConfirmDeleteId(u.id);
                                        setRowError(null);
                                    }}
                                    cancelDelete={() =>
                                        setConfirmDeleteId(null)
                                    }
                                    confirmDelete={() => confirmDelete(u.id)}
                                />
                            );
                        })
                    )}
                </tbody>
            </table>

            <TablePagination
                table={table}
                total={data.total}
                noun="user"
                busy={pending}
            />
        </div>
    );
}

// ---------------------------------------------------------------------------
// RowFragment — extracted to keep the parent JSX readable. Renders either a
// view row, an edit row, or a confirm-delete row, plus an inline error row
// when the most-recent failure belongs to this user.
// ---------------------------------------------------------------------------

type RowFragmentProps = {
    u: User;
    isEditing: boolean;
    isConfirming: boolean;
    pending: boolean;
    rowError: { id: number | "new"; message: string } | null;
    editDraft: EditDraft | null;
    setEditDraft: (d: EditDraft) => void;
    renderEditCells: (
        draft: EditDraft,
        setDraft: (d: EditDraft) => void,
        phoneRequired: boolean,
    ) => React.ReactNode;
    beginEdit: () => void;
    cancelEdit: () => void;
    saveEdit: () => void;
    askDelete: () => void;
    cancelDelete: () => void;
    confirmDelete: () => void;
};

function RowFragment(props: RowFragmentProps) {
    const {
        u,
        isEditing,
        isConfirming,
        pending,
        rowError,
        editDraft,
        setEditDraft,
        renderEditCells,
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
                {isEditing && editDraft ? (
                    renderEditCells(editDraft, setEditDraft, true)
                ) : (
                    <>
                        <td>{u.email ?? "—"}</td>
                        <td>{u.phone}</td>
                        <td>{u.username ?? "—"}</td>
                        <td>{u.role}</td>
                    </>
                )}
                <td>{fmtDate(u.created)}</td>
                <td>{fmtDate(u.lastLogin)}</td>
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
            {rowError?.id === u.id && (
                <tr className="adm-row-error">
                    <td colSpan={COL_COUNT}>{rowError.message}</td>
                </tr>
            )}
        </>
    );
}
