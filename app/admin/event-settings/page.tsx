import { getAdminState } from "@/lib/admin/globalState";
import EventSettingsForm from "./EventSettingsForm";

// ---------------------------------------------------------------------------
// /admin/event-settings — per-event Cvent configuration.
//
// Server component: reads the global admin state (active event + the full
// event list) and hands the active event's settings to the client form. The
// event being edited follows the global event switcher in the sidebar.
// ---------------------------------------------------------------------------

/**
 * Renders the Event settings page for the active event.
 *
 * @returns {Promise<JSX.Element>} The page element.
 */
export default async function EventSettingsPage() {
    const { events, activeEventCode } = await getAdminState();
    const active = events.find((e) => e.code === activeEventCode) ?? null;

    // Key on the active code so the form remounts (resetting its inputs from
    // props) whenever the active event changes — no in-component effect needed.
    return (
        <EventSettingsForm
            key={active?.code ?? "new"}
            active={active}
            hasEvents={events.length > 0}
        />
    );
}
