import "@/app/frontend.css";
import { redirect } from "next/navigation";
import { loadAttendees } from "@/lib/attendees/loader";
import { getCurrentIdentity } from "@/lib/auth/currentUser";
import { MissingEventCodeError } from "@/lib/helpers/getEventCode";
import SponsorCatalog from "@/app/components/SponsorCatalog";
import LogoutButton from "@/app/logout-button";

export default async function Home() {
    // The session must resolve to a known identity to view the catalog; the
    // resolved identity always carries its own attendee record.
    let identity: Awaited<ReturnType<typeof getCurrentIdentity>> = null;
    let attendees: Awaited<ReturnType<typeof loadAttendees>> = [];

    try {
        identity = await getCurrentIdentity();
        if (identity) attendees = await loadAttendees();
    } catch (err) {
        // Show a friendly notice if the event code is missing.
        // Anything else re-throws untouched.
        if (!(err instanceof MissingEventCodeError)) throw err;
        return <EventRequiredNotice />;
    }

    if (!identity) redirect("/login");
    // Admins can't act on the frontend — send them to the admin portal.
    if (identity.role === "admin") redirect("/admin");

    const delegates = attendees.filter((a) => a.role === "delegate");
    return (
        <SponsorCatalog
            delegates={delegates}
            currentSponsor={identity.attendee}
        />
    );
}

/**
 * Shown when a logged-in session has no event code attached — normally only
 * an existing session issued before /login started collecting one. Logging
 * out and back in re-runs that flow.
 */
function EventRequiredNotice() {
    return (
        <main className="login-page">
            <div className="login-card">
                <div className="login-brand">
                    <div className="logo-mark">DM</div>
                    Delegate Meeting Portal
                </div>
                <div className="login-heading">
                    <span className="login-eyebrow">Event not found</span>
                    <h1 className="login-title">Please log in again</h1>
                    <p className="login-lede">
                        Your session is missing an event code. Log out
                        and back in to enter it directly.
                    </p>
                </div>
                <LogoutButton className="login-btn-primary" />
            </div>
        </main>
    );
}
