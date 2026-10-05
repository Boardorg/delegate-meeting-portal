"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Button that clears the session cookie and redirects to /login.
 *
 * Returns null when NEXT_PUBLIC_DISABLE_LOGIN_AUTHENTICATION is on — there
 * is no session to log out of in that mode, so the button would be a no-op.
 * The variable is `NEXT_PUBLIC_` so Next.js inlines it into the client bundle.
 *
 * @returns {JSX.Element | null} The rendered button, or null when auth is bypassed.
 */
export default function LogoutButton() {
    const router = useRouter();
    const [pending, setPending] = useState(false);

    const authDisabled =
        process.env.NEXT_PUBLIC_DISABLE_LOGIN_AUTHENTICATION === "true";

    /**
     * Calls the logout API and navigates to /login.
     */
    async function handleLogout() {
        setPending(true);
        try {
            await fetch("/api/auth/logout", { method: "POST" });
            router.push("/login");
            router.refresh();
        } finally {
            setPending(false);
        }
    }

    return (
        <button
            type="button"
            className="logout-btn"
            onClick={handleLogout}
            disabled={pending || authDisabled}
        >
            {pending ? "Logging out…" : "Log out"}
        </button>
    );
}
