"use client";

import { useState, useTransition } from "react";
import type { User } from "@/lib/db/schema";
import { createUser, updateUser, deleteUser } from "./actions";

// ---------------------------------------------------------------------------
// UsersTable — interactive admin table.
//
// Server pieces (list/create/update/delete) live in ./actions.ts; this
// component owns the per-row UI state (which row is editing, which row is
// pending deletion confirmation, whether the new-user row is open).
//
// Mutations call the server actions through useTransition so the row can
// disable inputs while the request is in flight; on success Next.js
// re-renders the page via revalidatePath('/admin/users').
// ---------------------------------------------------------------------------

type Props = {
    users: User[];
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

/**
 * Formats a timestamp column for display as m/d/yyyy. Returns "—" for null so
 * the never-logged-in case is obvious at a glance.
 */
function fmtDate(d: Date | null): string {
    if (!d) return "—";
    return d.toLocaleDateString("en-US", {
        month: "numeric",
        day: "numeric",
        year: "numeric",
    });
}

export default function UsersTable({ users }: Props) {
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
                        className="users-input"
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
                        className="users-input"
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
                        className="users-input"
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
                        className="users-input"
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
        <div className="users-page">
            <div className="users-page-head">
                <h1 className="users-page-title">Users</h1>
                <button
                    type="button"
                    className="users-new-btn"
                    onClick={beginCreate}
                    disabled={creating || pending}
                >
                    + New user
                </button>
            </div>

            <table className="users-table">
                <thead>
                    <tr>
                        <th>Email</th>
                        <th>Phone</th>
                        <th>Username</th>
                        <th>Role</th>
                        <th>Created</th>
                        <th>Last login</th>
                        <th className="users-actions-col">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {creating && (
                        <>
                            <tr className="users-row users-row-new">
                                {renderEditCells(newDraft, setNewDraft, true)}
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
                                    <td colSpan={7}>{rowError.message}</td>
                                </tr>
                            )}
                        </>
                    )}

                    {users.length === 0 && !creating ? (
                        <tr>
                            <td colSpan={7} className="users-empty">
                                No users yet.
                            </td>
                        </tr>
                    ) : (
                        users.map((u) => {
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
            <tr className="users-row">
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
            {rowError?.id === u.id && (
                <tr className="users-row-error">
                    <td colSpan={7}>{rowError.message}</td>
                </tr>
            )}
        </>
    );
}
