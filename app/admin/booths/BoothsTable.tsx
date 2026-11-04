"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveBoothMapping } from "./actions";
import type { BoothRow } from "@/lib/scheduling/boothRows";
import { BOOTH_PROBLEM_LABEL } from "@/lib/scheduling/booths";

// ---------------------------------------------------------------------------
// BoothsTable — one row per sponsor company for /admin/booths.
//
// Shows the booth and meeting values read from Salesforce, and lets an admin
// pick which Cvent location a booth number means.
// Picking a location saves a manual mapping straight away.
// "Use automatic match" removes it.
// ---------------------------------------------------------------------------

/** A booths page row, plus its link to the Opportunity in Salesforce. */
export type BoothTableRow = BoothRow & { opportunityUrl: string | null };

/** A Cvent location the dropdown can offer. */
export type LocationOption = { id: string; name: string };

type Props = {
    eventCode: string | null;
    rows: BoothTableRow[];
    /** The event's Cvent locations that have sponsor_delegate slots. */
    locationOptions: LocationOption[];
    /** Set when the manual booth mapping couldn't be read. Mapping is then turned off. */
    loadError: string | null;
};

const COL_COUNT = 9;

/**
 * Renders the Sponsor booths table.
 *
 * @param {Props} props - The rows and dropdown options.
 * @returns {JSX.Element} The page body.
 */
export default function BoothsTable({
    eventCode,
    rows,
    locationOptions,
    loadError,
}: Props) {
    return (
        <div className="adm-page">
            <div className="adm-page-head">
                <h1 className="adm-page-title">Sponsor booths</h1>
            </div>

            <p className="adm-help-note">
                Booth numbers and meeting counts come from each sponsor&apos;s
                Opportunity in Salesforce. Change them there. Here you can only
                choose which Cvent location a booth number means.
            </p>

            {loadError && (
                <div className="adm-modal-error" role="alert">
                    {loadError}
                </div>
            )}

            <div className="adm-table-scroll">
                <table className="adm-table adm-table-wide">
                    <thead>
                        <tr>
                            <th>Company</th>
                            <th>Reps</th>
                            <th>Booth No.</th>
                            <th>Cvent location</th>
                            <th>Per slot</th>
                            <th>Purchased</th>
                            <th>Bonus</th>
                            <th>Maximum</th>
                            <th>At once</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.length === 0 ? (
                            <tr>
                                <td colSpan={COL_COUNT} className="adm-empty">
                                    {eventCode
                                        ? "No sponsors found for this event."
                                        : "No events found. Add an event in Event settings first."}
                                </td>
                            </tr>
                        ) : (
                            rows.map((row) => (
                                <BoothTableRowView
                                    key={row.accountId}
                                    row={row}
                                    eventCode={eventCode!}
                                    locationOptions={locationOptions}
                                    disabled={!!loadError}
                                />
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

/**
 * The plain label for where a row's Cvent location came from.
 *
 * @param {BoothRow} row - The row.
 * @returns {string} For example "Manual mapping", "Automatic match" or "No match".
 */
export function matchLabel(row: BoothRow): string {
    if (row.matchSource === "manual") return "Manual mapping";
    if (row.matchSource === "automatic") return "Automatic match";
    if (row.manualLocationId) return "Manual mapping to a location Cvent no longer has";
    return "No match";
}

/**
 * One company row, with its problems and warnings underneath.
 *
 * @param {{ row: BoothTableRow; eventCode: string; locationOptions: LocationOption[]; disabled: boolean }} props
 * @returns {JSX.Element} The row and its notes.
 */
function BoothTableRowView({
    row,
    eventCode,
    locationOptions,
    disabled,
}: {
    row: BoothTableRow;
    eventCode: string;
    locationOptions: LocationOption[];
    disabled: boolean;
}) {
    const notes = [
        ...row.problems.map((p) => BOOTH_PROBLEM_LABEL[p]),
        ...row.warnings,
    ];
    return (
        <>
            <tr className="adm-row">
                <td>
                    <div className="adm-party-name">{row.company}</div>
                    {row.opportunityUrl ? (
                        <a
                            href={row.opportunityUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="adm-link-btn"
                        >
                            Opportunity in Salesforce
                        </a>
                    ) : (
                        <span className="adm-mono-dim">
                            {row.opportunityId ?? "No Opportunity"}
                        </span>
                    )}
                </td>
                <td>
                    <div>
                        {row.reps
                            .map((r) =>
                                r.cancelled
                                    ? `${r.name} (cancelled)`
                                    : r.canHost
                                      ? r.name
                                      : `${r.name} (not in Cvent)`,
                            )
                            .join(", ")}
                    </div>
                    <div className="adm-mono-dim">
                        {row.hostCount} of {row.reps.length} can host
                    </div>
                </td>
                <td className="adm-mono">{row.boothNo ?? "—"}</td>
                <td>
                    <LocationSelect
                        row={row}
                        eventCode={eventCode}
                        locationOptions={locationOptions}
                        disabled={disabled}
                    />
                </td>
                <td className="adm-mono">{row.perSlotLimit ?? "—"}</td>
                <td className="adm-mono">{row.purchased ?? "—"}</td>
                <td className="adm-mono">{row.bonus ?? "—"}</td>
                <td className="adm-mono">
                    {row.maximum}
                    {row.maximumSource === "tier" && (
                        <span className="adm-mono-dim"> from tier</span>
                    )}
                </td>
                <td className="adm-mono">{row.meetingsAtOnce ?? "—"}</td>
            </tr>
            {notes.length > 0 && (
                <tr className="adm-row-error">
                    <td colSpan={COL_COUNT}>
                        {row.problems.length > 0 && (
                            <strong>No meetings until fixed: </strong>
                        )}
                        {notes.join(" ")}
                    </td>
                </tr>
            )}
        </>
    );
}

/**
 * The Cvent location dropdown for one row.
 * It shows the manual mapping, or offers "Use automatic match" with the location that gives.
 * Picking an option saves straight away.
 * A row with no booth number can't be mapped, since the mapping is keyed by booth number.
 *
 * @param {{ row: BoothTableRow; eventCode: string; locationOptions: LocationOption[]; disabled: boolean }} props
 * @returns {JSX.Element} The dropdown and its status.
 */
function LocationSelect({
    row,
    eventCode,
    locationOptions,
    disabled,
}: {
    row: BoothTableRow;
    eventCode: string;
    locationOptions: LocationOption[];
    disabled: boolean;
}) {
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    // Keep the mapped location selectable even when it has no sponsor slots, or Cvent no longer has it.
    const options = [...locationOptions];
    if (row.manualLocationId && !options.some((o) => o.id === row.manualLocationId)) {
        options.push({
            id: row.manualLocationId,
            name: row.location?.name ?? "Location Cvent no longer has",
        });
    }

    /**
     * Saves the picked location, or removes the mapping for "Use automatic match".
     *
     * @param {string} value - The picked location id, or "" for the automatic match.
     */
    function handleChange(value: string) {
        if (!row.boothNo) return;
        const boothNo = row.boothNo;
        startTransition(async () => {
            setError(null);
            const result = await saveBoothMapping({
                eventCode,
                boothNo,
                locationId: value === "" ? null : value,
            });
            if (!result.ok) {
                setError(result.error);
                return;
            }
            router.refresh();
        });
    }

    return (
        <div>
            <select
                className="adm-input adm-select"
                value={row.manualLocationId ?? ""}
                onChange={(e) => handleChange(e.target.value)}
                disabled={disabled || isPending || !row.boothNo}
            >
                <option value="">
                    Use automatic match ({row.automaticLocation?.name ?? "no match"})
                </option>
                {options.map((o) => (
                    <option key={o.id} value={o.id}>
                        {o.name}
                    </option>
                ))}
            </select>
            <div className="adm-mono-dim">
                {matchLabel(row)}
                {row.location ? `: ${row.location.name}` : ""}
            </div>
            {error && <div className="adm-modal-error">{error}</div>}
        </div>
    );
}
