import { getActiveEventCode } from "@/lib/admin/globalState";
import { loadAttendees } from "@/lib/attendees/loader";
import { loadEventScheduleData } from "@/lib/cvent/mapper";
import { loadBoothLocations } from "@/lib/scheduling/boothData";
import { buildBoothRows } from "@/lib/scheduling/boothRows";
import { sponsorSlotLocations } from "@/lib/scheduling/booths";
import BoothsTable from "./BoothsTable";

// ---------------------------------------------------------------------------
// /admin/booths is the Sponsor booths page.
//
// Server component: shows each sponsor company's booth, meeting counts and
// any problem that stops its meetings, for the active event.
// Booth numbers and meeting counts are read-only here.
// Salesforce stays the place to change them.
// The only thing an admin edits is which Cvent location a booth number means.
// ---------------------------------------------------------------------------

/**
 * Builds the Salesforce link for an Opportunity.
 * Uses SALESFORCE_BASE_URL, the org's instance URL. Without it there is no link.
 *
 * @param {string | null} opportunityId - The Opportunity id.
 * @returns {string | null} The Lightning record URL, or null.
 */
function opportunityUrl(opportunityId: string | null): string | null {
    const base = process.env.SALESFORCE_BASE_URL?.replace(/\/+$/, "");
    if (!base || !opportunityId) return null;
    return `${base}/lightning/r/Opportunity/${encodeURIComponent(opportunityId)}/view`;
}

/**
 * Renders the Sponsor booths page for the active event.
 *
 * @returns {Promise<JSX.Element>} The page element.
 */
export default async function AdminBoothsPage() {
    const eventCode = await getActiveEventCode();
    if (!eventCode) {
        return (
            <BoothsTable
                eventCode={null}
                rows={[]}
                locationOptions={[]}
                loadError={null}
            />
        );
    }

    const [attendees, scheduleData, mapping] = await Promise.all([
        loadAttendees(false, eventCode),
        loadEventScheduleData(eventCode),
        loadBoothLocations(eventCode),
    ]);

    // The dropdown offers the event's locations that have sponsor slots.
    const locationOptions = sponsorSlotLocations(
        scheduleData.locations,
        scheduleData.timeslots,
    ).map((l) => ({ id: l.id, name: l.name }));

    const rows = buildBoothRows(
        attendees,
        scheduleData.locations,
        scheduleData.timeslots,
        mapping.ok ? mapping.mappings : null,
    ).map((r) => ({ ...r, opportunityUrl: opportunityUrl(r.opportunityId) }));

    return (
        <BoothsTable
            eventCode={eventCode}
            rows={rows}
            locationOptions={locationOptions}
            loadError={mapping.ok ? null : mapping.error}
        />
    );
}
