import { isTestingMode } from "@/lib/helpers/testingMode";
import { getAdminState } from "@/lib/admin/globalState";
import { loadAttendees } from "@/lib/attendees/loader";
import EventSwitcher from "@/app/components/EventSwitcher";
import SponsorSwitcher, {
    type SpoofSponsorOption,
} from "@/app/components/SponsorSwitcher";
import TestingNavToggle from "@/app/components/TestingNavToggle";

// ---------------------------------------------------------------------------
// TestingBar — a global header bar shown on every page while TESTING_MODE is on
// (frontend and admin alike). It carries a copy of the event selector, the
// spoofed-sponsor selector, and a link that jumps between the frontend and the
// admin backend. Renders nothing outside testing mode.
// ---------------------------------------------------------------------------

/**
 * Renders the testing-mode bar, or nothing when testing mode is off.
 *
 * @returns {Promise<JSX.Element | null>} The bar, or null.
 */
export default async function TestingBar() {
    if (!isTestingMode()) return null;

    const { events, activeEventCode, spoofSponsorId } = await getAdminState();

    // Sponsors of the active event for the spoof selector. Guarded so a
    // Salesforce/Cvent hiccup can't take down every page in testing mode.
    let sponsors: SpoofSponsorOption[] = [];
    if (activeEventCode) {
        try {
            const attendees = await loadAttendees(false, activeEventCode);
            sponsors = attendees
                .filter((a) => a.role === "sponsor")
                .map((a) => ({
                    salesforceId: a.salesforceId,
                    name: a.name,
                    company: a.company,
                }));
        } catch {
            sponsors = [];
        }
    }

    return (
        <div className="testing-bar">
            <span className="testing-bar-badge">Testing mode</span>
            <EventSwitcher events={events} activeEventCode={activeEventCode} />
            <SponsorSwitcher sponsors={sponsors} selectedSponsorId={spoofSponsorId} />
            <TestingNavToggle />
        </div>
    );
}
