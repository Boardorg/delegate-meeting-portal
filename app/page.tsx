import "@/app/frontend.css";
import { redirect } from "next/navigation";
import { loadAttendees } from "@/lib/attendees/loader";
import { getCurrentIdentity } from "@/lib/auth/currentUser";
import { MissingEventCodeError } from "@/lib/helpers/getEventCode";
import SponsorCatalog from "@/app/components/SponsorCatalog";
import EventCodeForm from "@/app/components/EventCodeForm";

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
 * Shown when a logged-in session has no event code attached.
 * Lets the user enter their event code directly.
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
                    <span className="login-eyebrow">One more step</span>
                    <h1 className="login-title">Enter your event code</h1>
                    <p className="login-lede">
                        You can find this in the event email, or use the link
                        there to skip this step next time.
                    </p>
                </div>
                <EventCodeForm />
            </div>
        </main>
    );
}
