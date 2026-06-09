"use client";

import { type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

// ---------------------------------------------------------------------------
// AdminSidebar — left-rail navigation for the admin section.
//
// The nav list is data-driven via `items` so adding new sections later is a
// matter of appending entries. Each item can optionally render an icon and a
// list of sub-links; sub-links auto-expand when the current path matches the
// parent or any child.
// ---------------------------------------------------------------------------

/**
 * One nav entry. `href` is optional so an item can act as a pure group
 * header that only exists to host sub-links.
 */
export type AdminNavItem = {
    /** Visible link text. */
    label: string;
    /** Destination path (e.g. "/admin/users"). Optional for group-only items. */
    href?: string;
    /** Optional icon, rendered to the left of the label. Pass any ReactNode. */
    icon?: ReactNode;
    /** Optional nested links shown when the section is expanded. */
    children?: AdminNavItem[];
};

/**
 * Props for AdminSidebar.
 */
export type AdminSidebarProps = {
    items: AdminNavItem[];
};

/**
 * Returns true when `pathname` is `href` or a descendant of it. Used to
 * highlight active links and auto-expand any parent that contains the
 * currently-active route.
 *
 * @param {string} pathname - The current location pathname.
 * @param {string | undefined} href - The link's href.
 * @returns {boolean} Whether the link is active for the current path.
 */
function isActive(pathname: string, href: string | undefined): boolean {
    if (!href || href === "/admin") return false;
    return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Renders a single nav row, with an expand toggle when it has children. The
 * row is intentionally a plain <button> or <Link>; styling lives in
 * globals.css under `.admin-sidebar-*`.
 */
function NavRow({ item, depth }: { item: AdminNavItem; depth: number }) {
    const pathname = usePathname();
    const hasChildren = !!item.children?.length;

    const active = isActive(pathname, item.href);

    // Children are shown whenever this row, or any of its descendants, is the
    // current page. Purely derived from the URL — no open/closed JS state.
    const containsActive =
        hasChildren && item.children!.some((c) => isActive(pathname, c.href));
    const showChildren = hasChildren && (active || containsActive);

    // Shared inner content for both the link and the plain-row variants.
    const inner = (
        <>
            {item.icon && (
                <span className="admin-sidebar-icon">{item.icon}</span>
            )}
            <span className="admin-sidebar-label">{item.label}</span>
        </>
    );

    return (
        <div className="admin-sidebar-item" style={{ paddingLeft: depth * 12 }}>
            {item.href ? (
                <Link
                    href={item.href}
                    className={`admin-sidebar-row ${active ? "active" : ""}`}
                >
                    {inner}
                </Link>
            ) : (
                // Group-only rows (no href) just render as a static label —
                // there's nowhere for them to navigate to, and we no longer
                // toggle their children's visibility on click.
                <div className="admin-sidebar-row">{inner}</div>
            )}
            {showChildren && (
                <div className="admin-sidebar-children">
                    {item.children!.map((child) => (
                        <NavRow
                            key={child.label}
                            item={child}
                            depth={depth + 1}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * Sidebar root. Renders the list of nav rows
 *
 * @param {AdminSidebarProps} props - The nav structure to render.
 * @returns {JSX.Element} The sidebar element.
 */
export default function AdminSidebar({ items }: AdminSidebarProps) {
    return (
        <nav className="admin-sidebar" aria-label="Admin navigation">
            {items.map((item) => (
                <NavRow key={item.label} item={item} depth={0} />
            ))}
        </nav>
    );
}
