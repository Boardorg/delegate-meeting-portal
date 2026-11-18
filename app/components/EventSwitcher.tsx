"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { setActiveEvent } from "@/app/admin/actions";
import type { EventSettingsRow } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// EventSwitcher — the global admin event selector, rendered above the sidebar.
//
// Selecting an event writes the `admin_event` cookie (via setActiveEvent) and
// refreshes so every server component re-reads the new active event. The list
// comes from the event_settings registry.
// In the admin sidebar it also shows "+ New Event", which opens Event Settings in create mode.
// The testing bar reuses it without that link.
// ---------------------------------------------------------------------------

type Props = {
    events: EventSettingsRow[];
    activeEventCode: string | null;
    /** Where "+ New Event" goes. The link is hidden when this is left out. */
    newEventHref?: string;
};

export default function EventSwitcher({ events, activeEventCode, newEventHref }: Props) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();

    function onChange(code: string) {
        startTransition(async () => {
            await setActiveEvent(code);
            router.refresh();
        });
    }

    return (
        <div className="admin-event-switcher">
            <span className="admin-event-switcher-label">Event</span>
            {events.length === 0 ? (
                <div className="admin-event-switcher-empty">
                    No events yet.
                </div>
            ) : (
                <select
                    className="admin-event-switcher-select"
                    value={activeEventCode ?? ""}
                    onChange={(e) => onChange(e.target.value)}
                    disabled={pending}
                    aria-label="Active event"
                >
                    {events.map((e) => (
                        <option key={e.code} value={e.code}>
                            {e.name ? `${e.name} (${e.code})` : e.code}
                        </option>
                    ))}
                </select>
            )}
            {newEventHref && (
                <Link href={newEventHref} className="adm-new-btn admin-new-event-link">
                    + New Event
                </Link>
            )}
        </div>
    );
}
