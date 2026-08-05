import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import "@/app/backend.css";
import TopBar from "@/app/components/TopBar";
import AdminSidebar from "@/app/components/AdminSidebar";
import EventSwitcher from "@/app/components/EventSwitcher";
import { getAdminState } from "@/lib/admin/globalState";
import { getEventLogo } from "@/lib/events/logo";
import { ADMIN_NAV } from "./nav";

// ---------------------------------------------------------------------------
// /admin layout
//
// Wraps every page under /admin with the shared TopBar (no "My Requests" — the
// admin context doesn't have meeting requests) and a fixed left-side sidebar
// for navigation between admin sections.
//
// Also gates the section by role: any logged-in non-admin who lands on
// /admin/* is bounced to "/" before the page renders.
// ---------------------------------------------------------------------------

/**
 * Renders the admin shell around child pages.
 *
 * @param {{ children: ReactNode }} props - The nested admin page.
 * @returns {Promise<JSX.Element>} The admin layout element.
 */
export default async function AdminLayout({
    children,
}: {
    children: ReactNode;
}) {
    // proxy.ts already enforces "must be logged in" — this is the role check.
    // A missing user row means the phone-only session has no admin grant, so
    // they get the same treatment as a logged-in non-admin: redirect home.
    //
    // NEXT_PUBLIC_DISABLE_LOGIN_AUTHENTICATION mirrors the proxy's bypass:
    // when it's "true" (local dev / preview environments) we skip the role
    // check too, so the admin area is reachable without any users-table row.
    const authDisabled =
        process.env.NEXT_PUBLIC_DISABLE_LOGIN_AUTHENTICATION === "true";
    const { user, events, activeEventCode } = await getAdminState();
    if (!authDisabled && (!user || user.role !== "admin")) {
        redirect("/");
    }

    // Show the most-specific identifier we have for the user, in priority
    // order: username → email → phone. When auth is disabled and there's no
    // session, fall back to a generic placeholder.
    const displayName = user
        ? (user.username ?? user.email ?? user.phone)
        : "Anonymous";
    const displayRole = user?.role ?? "auth disabled";

    // Show the active event's logo (if it has one) next to the Assemble mark,
    // labelled with the event's friendly name or its code.
    const activeEvent = events.find((e) => e.code === activeEventCode);
    const logo = getEventLogo(activeEventCode);
    const eventLogo = logo
        ? { ...logo, alt: activeEvent?.name ?? activeEventCode ?? "Event" }
        : null;

    return (
        <>
            <TopBar
                user={{ name: displayName, title: displayRole }}
                eventLogo={eventLogo}
            />
            <div className="admin-shell">
                <div className="admin-sidebar-col">
                    <EventSwitcher events={events} activeEventCode={activeEventCode} />
                    <AdminSidebar items={ADMIN_NAV} />
                </div>
                <main className="admin-main">{children}</main>
            </div>
        </>
    );
}
