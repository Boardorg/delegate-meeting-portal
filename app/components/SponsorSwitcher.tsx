"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setSpoofSponsor } from "@/app/admin/actions";

// ---------------------------------------------------------------------------
// SponsorSwitcher — testing-mode-only selector (under the event switcher) that
// picks which sponsor of the active event an admin is spoofed as on the
// frontend. Selecting one writes the `admin_spoof_sponsor` cookie and refreshes
// so the frontend identity picks it up.
// ---------------------------------------------------------------------------

/** A sponsor option for the spoof selector. */
export type SpoofSponsorOption = {
    salesforceId: string;
    name: string;
    company: string;
};

type Props = {
    sponsors: SpoofSponsorOption[];
    selectedSponsorId: string | null;
};

export default function SponsorSwitcher({ sponsors, selectedSponsorId }: Props) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();

    function onChange(salesforceId: string) {
        startTransition(async () => {
            await setSpoofSponsor(salesforceId);
            router.refresh();
        });
    }

    // Fall back to the first sponsor for the highlighted value when the cookie
    // is unset or points at a sponsor from a different event — matching how the
    // identity resolver picks the spoof target.
    const value =
        selectedSponsorId && sponsors.some((s) => s.salesforceId === selectedSponsorId)
            ? selectedSponsorId
            : (sponsors[0]?.salesforceId ?? "");

    return (
        <div className="admin-event-switcher">
            <span className="admin-event-switcher-label">Spoof sponsor</span>
            {sponsors.length === 0 ? (
                <div className="admin-event-switcher-empty">
                    No sponsors for this event.
                </div>
            ) : (
                <select
                    className="admin-event-switcher-select"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    disabled={pending}
                    aria-label="Spoofed sponsor"
                >
                    {sponsors.map((s) => (
                        <option key={s.salesforceId} value={s.salesforceId}>
                            {s.company ? `${s.name} — ${s.company}` : s.name}
                        </option>
                    ))}
                </select>
            )}
        </div>
    );
}
