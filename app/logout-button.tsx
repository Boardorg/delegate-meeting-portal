"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Button that clears the session cookie and redirects to /login.
 *
 * @returns {JSX.Element} The rendered button.
 */
export default function LogoutButton() {
    const router = useRouter();
    const [pending, setPending] = useState(false);

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
            onClick={handleLogout}
            disabled={pending}
            style={{
                padding: "6px 12px",
                fontSize: 14,
                cursor: "pointer",
            }}
        >
            {pending ? "Logging out…" : "Log out"}
        </button>
    );
}
