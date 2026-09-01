import type { ReactNode } from "react";
import type { Attendee } from "@/types";
import { str } from "@/app/components/catalogFormat";

// ---------------------------------------------------------------------------
// DetailsModal — every profile detail we have for a delegate, plus a slot for
// the request/edit/remove action group. Opened from both the grid card's and the
// list row's "More details" button; the caller owns the open/close state and
// passes the action group as children so it stays wired to the catalog's request
// state.
//
// This is the only place the delegate's full intake-form profile is shown, so it
// carries the fields the cards and columns have no room for: progress on
// interest areas, systems and platforms, and meeting interests.
// ---------------------------------------------------------------------------

export default function DetailsModal({
    d,
    revClass,
    onClose,
    children,
}: {
    d: Attendee;
    /**
     * The `rev-N` class for this delegate's revenue chip. Computed by the caller
     * because the grading depends on the whole delegate pool's revenue values,
     * which only the catalog knows.
     */
    revClass: string;
    onClose: () => void;
    /** The RequestActions group, wired to the parent's request state. */
    children: ReactNode;
}) {
    const p = d.profile;
    const rc = revClass || "rev-na";

    // Scalar attributes rendered as label/value rows. Filtered so a delegate who
    // skipped a question doesn't get a row of "N/A"s — revenue always shows,
    // since its chip doubles as the card's visual anchor.
    const attrs = [
        { label: "Budget resp.", value: p.budgetaryResponsibility },
        { label: "Co. size", value: p.companySize },
        { label: "Progress on interest areas", value: p.transformationStage },
        { label: "Priority initiative", value: p.priorityInitiative },
    ].filter((a) => a.value);

    // Multi-value attributes rendered as label + dot-separated list.
    const groups = [
        { label: "Planned Interest Areas", items: p.interestAreas },
        { label: "Industries", items: p.industrySectors },
        { label: "Systems and Platforms", items: p.systemsAndPlatforms },
        { label: "Meeting Interests", items: p.meetingInterests },
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
                        {attrs.map((a) => (
                            <div key={a.label} className="card-attr">
                                <span className="ca-label">{a.label}</span>
                                <span className="ca-value">{a.value}</span>
                            </div>
                        ))}
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
