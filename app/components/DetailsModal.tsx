import type { ReactNode } from "react";
import type { Attendee } from "@/types";
import { dotTags } from "@/app/components/catalogFormat";

// ---------------------------------------------------------------------------
// DetailsModal — EVERY intake-form answer we have for a delegate (the full
// picture, beyond the core columns shown on the card/row), plus a slot for the
// request/edit/remove action group. Opened from the card/row "More details"
// button; the caller owns the open/close state and passes the action group as
// children so it stays wired to the catalog's request state.
// ---------------------------------------------------------------------------

export default function DetailsModal({
    d,
    onClose,
    children,
}: {
    d: Attendee;
    onClose: () => void;
    /** The RequestActions group, wired to the parent's request state. */
    children: ReactNode;
}) {
    return (
        <div className="details-overlay open" onClick={onClose}>
            <div
                className="details-modal"
                role="dialog"
                aria-modal="true"
                aria-label={`${d.company} details`}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="drawer-head">
                    <div className="d-meta">
                        <div className="d-company">{d.company}</div>
                        <div className="d-name">{d.name}</div>
                        <div className="d-title">{d.title}</div>
                    </div>
                    <button
                        className="drawer-close"
                        onClick={onClose}
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>
                <div className="details-body">
                    {/* All of the delegate's form answers (one row per field). */}
                    {d.formFields.length === 0 ? (
                        <div className="card-more-group-val">
                            No details provided.
                        </div>
                    ) : (
                        <div className="details-groups">
                            {d.formFields.map((f) => (
                                <div key={f.key} className="details-group">
                                    <div className="card-more-group-label">
                                        {f.label}
                                    </div>
                                    <div className="card-more-group-val">
                                        {dotTags(f.values) || "N/A"}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <div className="details-action">{children}</div>
            </div>
        </div>
    );
}
