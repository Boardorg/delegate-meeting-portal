"use client";

// ---------------------------------------------------------------------------
// ProgressCell — a "count / total" bar shared by the Requests and Scheduled
// columns. Color reflects standing against the target: blue while under 80%,
// gold from 80-99%, green at exactly 100%, red once over.
// ---------------------------------------------------------------------------

/**
 * A "count / total" progress bar.
 *
 * @param {{ count: number; total: number; percent: number }} props - The count, the target and the percent filled.
 * @returns {JSX.Element} The bar.
 */
export function ProgressCell({
    count,
    total,
    percent,
}: {
    count: number;
    total: number;
    percent: number;
}) {
    const isOver = count > total;
    const barColor = isOver
        ? "var(--red)"
        : percent >= 100
          ? "var(--progress-full)"
          : percent >= 80
            ? "var(--gold)"
            : "var(--progress-mid)";

    return (
        <div className="adm-progress">
            <div className="adm-progress-track">
                <div
                    className="adm-progress-bar"
                    style={{ width: `${Math.min(percent, 100)}%`, background: barColor }}
                />
            </div>
            <span className="adm-progress-label">{count} / {total}</span>
        </div>
    );
}
