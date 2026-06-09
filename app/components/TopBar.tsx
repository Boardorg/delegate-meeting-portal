import type { ReactNode } from "react";
import LogoutButton from "@/app/logout-button";

// ---------------------------------------------------------------------------
// TopBar — the portal's shared sticky header. Reused across the sponsor
// catalog and the admin pages.
//
// The page-specific bits (the "My Requests" button on the sponsor view, the
// nothing-yet on admin) come in through the `actions` slot so this component
// itself stays presentation-only.
// ---------------------------------------------------------------------------

/**
 * Minimal user data shown in the right-side identity chip. Provide only when
 * a relevant user/context exists for the page (e.g. the current sponsor on
 * the catalog view). Omit on admin/system pages.
 */
export type TopBarUser = {
    name: string;
    /** Optional secondary line beneath the name (e.g. job title). */
    title?: string;
};

/**
 * Props for the TopBar.
 */
export type TopBarProps = {
    /** Optional user-identity chip shown to the left of `actions`. */
    user?: TopBarUser;
    /** Page-specific buttons (e.g. "My Requests") rendered to the left of logout. */
    actions?: ReactNode;
};

/**
 * Renders the portal's sticky top header: brand mark, optional user chip,
 * page-specific action slot, and a logout button.
 *
 * @param {TopBarProps} props - User + action-slot overrides.
 * @returns {JSX.Element} The header element.
 */
export default function TopBar({ user, actions }: TopBarProps) {
    return (
        <header className="topbar">
            <div className="topbar-logo">
                <div className="logo-mark">DM</div>
                Delegate Meeting Portal
            </div>
            <div className="topbar-spacer" />
            <div className="topbar-right">
                {user && (
                    <>
                        <div className="user-chip">
                            <div>
                                <div className="user-name">{user.name}</div>
                                {user.title && (
                                    <div className="user-sub">{user.title}</div>
                                )}
                            </div>
                        </div>
                        <LogoutButton />
                    </>
                )}
                {actions}
            </div>
        </header>
    );
}
