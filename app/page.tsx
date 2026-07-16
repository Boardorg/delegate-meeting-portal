import "@/app/frontend.css";
import { redirect } from "next/navigation";
import { loadAttendees } from "@/lib/attendees/loader";
import { getCurrentIdentity } from "@/lib/auth/currentUser";
import { MissingEventCodeError } from "@/lib/helpers/getEventCode";
import SponsorCatalog from "@/app/components/SponsorCatalog";

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
 * Shown when someone opens the portal without an event code — they arrived
 * without following their emailed event link.
 */
function EventRequiredNotice() {
    return (
        <main className="event-notice">
            <h1 className="event-notice-title">Event not found</h1>
            <p className="event-notice-text">
                Please use the event link in your email to access the portal.
            </p>
        </main>
    );
}
