import type { ReactNode } from "react";
import type { Attendee } from "@/types";
import { revClass, str } from "@/app/components/catalogFormat";

// ---------------------------------------------------------------------------
// DetailsModal — every company detail we have for a delegate (mirrors the grid
// card with its "more details" expanded), plus a slot for the request/edit/
// remove action group. Opened from the list view's trailing "More details"
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
    const p = d.profile;
    const rc = revClass(p.annualRevenue) || "rev-na";
    const groups = [
        { label: "Specialization", items: p.areasOfSpecialization },
        { label: "Industries", items: p.industrySectors },
        { label: "Regions", items: p.regionsOverseen },
        { label: "Priorities", items: p.strategicPriorities },
    ].filter((g) => g.items?.length);

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
                    <div className="card-attrs">
                        <div className="card-attr">
                            <span className="ca-label">Revenue</span>
                            <span className={`${rc} rev-chip`}>
                                {str(p.annualRevenue)}
                            </span>
                        </div>
                        <div className="card-attr">
                            <span className="ca-label">Budget resp.</span>
                            <span className="ca-value">
                                {p.budgetaryResponsibility || "N/A"}
                            </span>
                        </div>
                        <div className="card-attr">
                            <span className="ca-label">Planned spend</span>
                            <span className="ca-value">
                                {p.plannedSpend || "N/A"}
                            </span>
                        </div>
                        <div className="card-attr">
                            <span className="ca-label">Co. size</span>
                            <span className="ca-value">
                                {str(p.companySize)}
                            </span>
                        </div>
                    </div>
                    {groups.length > 0 && (
                        <div className="details-groups">
                            {groups.map((g) => (
                                <div key={g.label} className="details-group">
                                    <div className="card-more-group-label">
                                        {g.label}
                                    </div>
                                    <div className="card-more-group-val">
                                        {g.items.join(" · ")}
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
