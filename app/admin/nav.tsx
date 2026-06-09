import type { AdminNavItem } from "@/app/components/AdminSidebar";

// ---------------------------------------------------------------------------
// Admin navigation structure.
//
// Centralized here so the sidebar and any future breadcrumb / page-title
// utilities read from a single source. Add new entries (and sub-links) to
// this list — AdminSidebar renders them generically.
// ---------------------------------------------------------------------------

export const ADMIN_NAV: AdminNavItem[] = [
    {
        label: "Admin Home",
        href: "/admin",
        children: [],
    },
    {
        label: "Users",
        href: "/admin/users",
        icon: "👤",
        children: [],
    },
];
