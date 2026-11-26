"use client";

import { fmtTime } from "@/lib/format";
import { groupSlotOptions, type SlotOption } from "@/lib/scheduling/slotOptions";

// ---------------------------------------------------------------------------
// Time slot picker shared by the Edit and Create Meeting windows.
// Moved out of app/admin/meetings/[sponsorId]/MeetingDetail.tsx so the delegate meeting page can use it too.
// ---------------------------------------------------------------------------

/**
 * The Time Slot dropdown. Options are grouped by Cvent appointment type, sponsor slots first.
 * Each option also names its type, so the choice is clear while the list is closed.
 *
 * @param {{ options: SlotOption[]; value: string; onChange: (key: string) => void; disabled: boolean; timezone: string }} props
 * @returns {JSX.Element} The select element.
 */
export function SlotSelect({
    options,
    value,
    onChange,
    disabled,
    timezone,
}: {
    options: SlotOption[];
    value: string;
    onChange: (key: string) => void;
    disabled: boolean;
    timezone: string;
}) {
    return (
        <select
            className="adm-input adm-select"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
        >
            {/* Nothing is chosen yet, for example when the current slot is at another company's booth. */}
            {value === "" && (
                <option value="" disabled>
                    Choose a time slot
                </option>
            )}
            {groupSlotOptions(options).map((g, i) => (
                <optgroup key={`${i}-${g.label}`} label={g.label}>
                    {g.options.map((o) => (
                        <option key={o.timeslotId} value={o.timeslotId}>
                            Day {o.day} – {fmtTime(o.startTime, timezone)}
                            {o.locationName ? ` · ${o.locationName}` : ""}
                            {` · ${g.label}`}
                        </option>
                    ))}
                </optgroup>
            ))}
        </select>
    );
}
