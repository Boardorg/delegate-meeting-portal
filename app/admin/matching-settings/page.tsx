import { getActiveEventCode } from "@/lib/admin/globalState";
import { loadEventScheduleData } from "@/lib/cvent/mapper";
import { loadMatchingSettings } from "@/lib/matching/data";
import { roundtableSlots } from "@/lib/matching/roundtables";
import MatchingSettingsForm, { type CventRoundtable } from "./MatchingSettingsForm";

// ---------------------------------------------------------------------------
// /admin/matching-settings — the delegate matching settings for the selected event.
//
// Admins set the D2D and roundtable question priorities, the meeting caps, and seats and
// alternates per table. The page also lists the roundtables found in Cvent, so admins can
// check every table is set up.
// ---------------------------------------------------------------------------

/**
 * Renders the Matching Settings page for the selected event.
 *
 * @returns {Promise<JSX.Element>} The page element.
 */
export default async function MatchingSettingsPage() {
    const eventCode = await getActiveEventCode();
    if (!eventCode) {
        return (
            <div className="adm-page">
                <div className="adm-page-head">
                    <h1 className="adm-page-title">Matching Settings</h1>
                </div>
                <div className="adm-empty adm-empty-lg">No events yet.</div>
            </div>
        );
    }

    const [settings, schedule] = await Promise.all([loadMatchingSettings(eventCode), loadEventScheduleData(eventCode)]);
    const roundtables: CventRoundtable[] = roundtableSlots(schedule.timeslots).map((t) => ({
        timeslotId: t.id,
        location: (t.locationId ? schedule.locationById.get(t.locationId)?.name : undefined) ?? "No location in Cvent",
        startTime: t.startTime,
    }));
    const d2dSlots = schedule.timeslots.filter((t) => t.kind === "delegate_delegate").length;

    // Key on the event so the form resets its inputs when the event changes.
    return (
        <MatchingSettingsForm
            key={eventCode}
            eventCode={eventCode}
            initial={settings}
            roundtables={roundtables}
            d2dSlots={d2dSlots}
            timezone={schedule.timezone}
        />
    );
}
