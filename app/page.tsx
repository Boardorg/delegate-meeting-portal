import "@/app/frontend.css";
import { redirect } from "next/navigation";
import { loadAttendees } from "@/lib/attendees/loader";
import { getCurrentIdentity } from "@/lib/auth/currentUser";
import { getEventCode } from "@/lib/helpers/getEventCode";
import { getEventSettings } from "@/lib/events/settings";
import { eventThemeVars } from "@/lib/events/theme";
import type { TopBarEventLogo } from "@/app/components/TopBar";
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

    // Resolve the active event's per-event Brand Color (drives the catalog's
    // --accent accent) and its header logo URL. Any failure to resolve an event
    // (e.g. MissingEventCodeError) leaves both null, so the default teal + no
    // logo apply.
    let themeColor: string | null = null;
    let eventLogo: TopBarEventLogo | null = null;
    try {
        const code = await getEventCode();
        const settings = await getEventSettings(code);
        themeColor = settings?.themeColor ?? null;
        if (settings?.logoUrl) {
            eventLogo = { src: settings.logoUrl, alt: settings.name ?? code };
        }
    } catch {
        // No resolvable event — keep the fallback teal and no event logo.
    }

    return (
        // display:contents so this wrapper only carries the theme variables
        // (which inherit into the catalog) without adding a box that could
        // disturb the sticky topbar / full-height page layout.
        <div style={{ display: "contents", ...eventThemeVars(themeColor) }}>
            <SponsorCatalog
                delegates={delegates}
                currentSponsor={identity.attendee}
                eventLogo={eventLogo}
            />
        </div>
    );
}
