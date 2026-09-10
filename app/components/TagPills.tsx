import {
    SHORT_TAG_MAX,
    shortenValue,
    tagColorClass,
} from "@/app/components/catalogFormat";

// ---------------------------------------------------------------------------
// TagPills — a delegate's interest areas as colorized pills, one per line.
//
// Each pill's color identifies its value (see tagColorClass), so a requester can
// spot the same interest area across rows without reading the text: the intake
// form's answers are long enough that they were unreadable as a wrapped run of
// dot-separated text.
//
// Labels are always shortened — a pill is too small for the full answer anywhere
// it appears — with the complete text on the pill's tooltip and in the sidebar
// filter's option list. Two shapes, one implementation:
//   - grid card / list row / hcard — capped at `limit` with a trailing "+N" that
//     opens the details modal, and clickable to toggle the matching filter.
//   - details modal — every value, read-only, and a longer `max` to suit the
//     wider panel.
// ---------------------------------------------------------------------------

export default function TagPills({
    values,
    order,
    activeValues,
    limit,
    max = SHORT_TAG_MAX,
    onToggle,
    onMore,
}: {
    values: string[];
    /** The event's ordered option list, which fixes each value's color. */
    order: string[];
    /** Values currently selected in the corresponding sidebar filter. */
    activeValues: string[];
    /** Pills to show before collapsing the rest into "+N". Omit to show all. */
    limit?: number;
    /** Characters per label. Defaults to the compact views' budget. */
    max?: number;
    /** Toggles a value in the sidebar filter. Omit to render non-interactive pills. */
    onToggle?: (value: string) => void;
    /** Opens the details modal from the "+N" pill. */
    onMore?: () => void;
}) {
    if (!values.length) return null;

    const shown = limit ? values.slice(0, limit) : values;
    const hidden = values.length - shown.length;

    return (
        <div className="tag-pills">
            {shown.map((v) => {
                const cls = [
                    "tag-pill",
                    tagColorClass(v, order),
                    activeValues.includes(v) ? "is-active" : "",
                ]
                    .filter(Boolean)
                    .join(" ");

                // Non-interactive contexts render a span, so there's no button
                // affordance on something that can't be clicked. Either way the
                // pill carries the full answer as its tooltip.
                return onToggle ? (
                    <button
                        key={v}
                        type="button"
                        className={cls}
                        title={v}
                        onClick={() => onToggle(v)}
                    >
                        {shortenValue(v, max)}
                    </button>
                ) : (
                    <span key={v} className={cls} title={v}>
                        {shortenValue(v, max)}
                    </span>
                );
            })}
            {hidden > 0 && (
                <button
                    type="button"
                    className="tag-pill tag-pill-more"
                    onClick={onMore}
                    title={`${hidden} more — open full details`}
                >
                    +{hidden}
                </button>
            )}
        </div>
    );
}
