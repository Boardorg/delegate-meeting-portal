"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// ---------------------------------------------------------------------------
// TestingNavToggle — the testing bar's frontend ↔ backend jump link. On the
// admin side it links to the frontend; everywhere else it links to /admin.
// ---------------------------------------------------------------------------

export default function TestingNavToggle() {
    const pathname = usePathname();
    const onAdmin = pathname.startsWith("/admin");

    return (
        <Link className="testing-bar-nav" href={onAdmin ? "/" : "/admin"}>
            {onAdmin ? "Frontend →" : "Admin →"}
        </Link>
    );
}
