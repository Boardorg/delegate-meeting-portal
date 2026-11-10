import type { AdminNavItem } from "@/app/components/AdminSidebar";

// ---------------------------------------------------------------------------
// Admin navigation structure.
//
// Centralized here so the sidebar and any future breadcrumb / page-title
// utilities read from a single source. Add new entries (and sub-links) to
// this list — AdminSidebar renders them generically.
//
// Pages for the event chosen in the event picker come first, grouped by area, with Event Settings last.
// Pages that apply to every event sit below a divider at the bottom.
// Labels use Title Case.
// ---------------------------------------------------------------------------

export const ADMIN_NAV: AdminNavItem[] = [
    {
        label: "Overview",
        href: "/admin",
        icon: "🏠",
        children: [],
    },
    {
        // A group heading with no page of its own.
        label: "Sponsor Meetings",
        children: [
            {
                label: "Sponsor Meeting Requests",
                href: "/admin/requests",
                icon: "🤝",
            },
            {
                label: "Sponsor Meetings",
                href: "/admin/meetings",
                icon: "📅",
            },
            {
                label: "Sponsor Booths",
                href: "/admin/booths",
                icon: "🏷️",
            },
        ],
    },
    {
        label: "Event Settings",
        href: "/admin/event-settings",
        icon: "⚙️",
        children: [],
    },
    {
        label: "Users",
        href: "/admin/users",
        icon: "👤",
        children: [],
        // Users applies to every event, so it sits below a divider.
        dividerAbove: true,
    },
];
