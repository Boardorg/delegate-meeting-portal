"use client";

import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// ConfirmModal: the confirmation dialog behind the meeting pages' header buttons.
//
// Shared by Sponsor Meetings, Delegate Meetings and Roundtables, so "Run", "Push All to Cvent",
// "Clear All Unsynced" and "Unpush All Synced" confirm the same way on every page.
// ---------------------------------------------------------------------------

/**
 * A confirmation dialog with Cancel and a confirm button.
 *
 * @param {{ title: string; children: ReactNode; confirmLabel: string; pendingLabel: string; tone?: "primary" | "danger"; isPending: boolean; error: string | null; onConfirm: () => void; onCancel: () => void }} props
 *   The title, the body, the confirm button's labels and colour, and the handlers.
 * @returns {JSX.Element} The dialog.
 */
export function ConfirmModal({
    title,
    children,
    confirmLabel,
    pendingLabel,
    tone = "primary",
    isPending,
    error,
    onConfirm,
    onCancel,
}: {
    title: string;
    children: ReactNode;
    confirmLabel: string;
    pendingLabel: string;
    tone?: "primary" | "danger";
    isPending: boolean;
    error: string | null;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="adm-modal-overlay">
            <div className="adm-modal adm-modal-md">
                <div className="adm-modal-title">{title}</div>
                {children}
                {error && <div className="adm-modal-error">{error}</div>}
                <div className="adm-modal-actions">
                    <button className="adm-btn" onClick={onCancel} disabled={isPending}>Cancel</button>
                    <button
                        className={`adm-btn ${tone === "danger" ? "adm-btn-danger" : "adm-btn-primary"}`}
                        onClick={onConfirm}
                        disabled={isPending}
                    >
                        {isPending ? pendingLabel : confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
