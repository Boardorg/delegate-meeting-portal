import { isTestingMode } from "@/lib/helpers/testingMode";
import { getAdminState } from "@/lib/admin/globalState";
import { getCurrentUser } from "@/lib/auth/currentUser";
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
//
// The controls only appear once they can actually do something. Every one of
// them is an admin tool — switching the active event, standing in as a sponsor,
// jumping to /admin — and none has any effect for a visitor sitting on the login
// screen, so pre-login the bar shrinks to just its badge. That also keeps the
// login page off the Salesforce + Cvent round-trip the sponsor list needs.
// ---------------------------------------------------------------------------

/**
 * True when the testing-bar controls should be shown: a real admin session, or
 * the dev auth bypass (where there is no session at all but the spoofed admin
 * identity — and therefore the switchers — is live). See
 * lib/auth/currentUser.ts.
 *
 * @returns {Promise<boolean>} Whether to render the controls.
 */
async function canUseTestingControls(): Promise<boolean> {
    if (process.env.NEXT_PUBLIC_DISABLE_LOGIN_AUTHENTICATION === "true") {
        return true;
    }
    // The session's real identity, not the spoofed one — an admin standing in as
    // a sponsor still gets the controls.
    const user = await getCurrentUser();
    return user?.role === "admin";
}

/**
 * Renders the testing-mode bar, or nothing when testing mode is off.
 *
 * @returns {Promise<JSX.Element | null>} The bar, or null.
 */
export default async function TestingBar() {
    if (!isTestingMode()) return null;

    // Badge-only until an admin is logged in.
    if (!(await canUseTestingControls())) {
        return (
            <div className="testing-bar">
                <span className="testing-bar-badge">Testing mode</span>
            </div>
        );
    }

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
                }))
                // Alphabetical by name (the dropdown's leading label), with
                // company as a tiebreaker; case-insensitive.
                .sort((a, b) =>
                    a.name.localeCompare(b.name, undefined, {
                        sensitivity: "base",
                    }),
                );
        } catch {
            sponsors = [];
        }
    }

    return (
        <div className="testing-bar">
            <span className="testing-bar-badge">Testing mode</span>
            <EventSwitcher events={events} activeEventCode={activeEventCode} />
            <SponsorSwitcher
                sponsors={sponsors}
                selectedSponsorId={spoofSponsorId}
            />
            <TestingNavToggle />
        </div>
    );
}
