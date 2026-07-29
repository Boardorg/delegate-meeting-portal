import "@/app/frontend.css";
import { redirect } from "next/navigation";
import { loadAttendees } from "@/lib/attendees/loader";
import { getCurrentIdentity } from "@/lib/auth/currentUser";
import SponsorCatalog from "@/app/components/SponsorCatalog";

export default async function Home() {
    // The session must resolve to a known identity to view the catalog; the
    // resolved identity always carries its own attendee record.
    const identity = await getCurrentIdentity();
    if (!identity) redirect("/login");
    // Admins can't act on the frontend — send them to the admin portal.
    if (identity.role === "admin") redirect("/admin");

    const attendees = await loadAttendees();
    const delegates = attendees.filter((a) => a.role === "delegate");
    return (
        <SponsorCatalog
            delegates={delegates}
            currentSponsor={identity.attendee}
        />
    );
}
