import type { ReactNode } from "react";
import "@/app/backend.css";
import TopBar from "@/app/components/TopBar";
import AdminSidebar from "@/app/components/AdminSidebar";
import { ADMIN_NAV } from "./nav";

// ---------------------------------------------------------------------------
// /admin layout
//
// Wraps every page under /admin with the shared TopBar (no "My Requests" — the
// admin context doesn't have meeting requests) and a fixed left-side sidebar
// for navigation between admin sections.
// ---------------------------------------------------------------------------

/**
 * Renders the admin shell around child pages.
 *
 * @param {{ children: ReactNode }} props - The nested admin page.
 * @returns {JSX.Element} The admin layout element.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
    return (
        <>
            <TopBar />
            <div className="admin-shell">
                <AdminSidebar items={ADMIN_NAV} />
                <main className="admin-main">{children}</main>
            </div>
        </>
    );
}
