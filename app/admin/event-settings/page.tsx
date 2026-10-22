import { getAdminState } from "@/lib/admin/globalState";
import { getAppointmentTypes } from "@/lib/cvent/client";
import type { EventSettingsRow } from "@/lib/db/schema";
import EventSettingsForm, {
    type AppointmentTypesLoad,
} from "./EventSettingsForm";

// ---------------------------------------------------------------------------
// /admin/event-settings — per-event Cvent configuration.
//
// Server component: reads the global admin state (active event + the full
// event list) and hands the active event's settings to the client form. The
// event being edited follows the global event switcher in the sidebar.
//
// It also lists the active event's Cvent appointment types, so the form can map each one to a meeting kind.
// ---------------------------------------------------------------------------

/**
 * Lists the event's Cvent appointment types for the mapping section.
 * A failure never breaks the page. The form explains why the list is missing and still saves everything else.
 *
 * @param {EventSettingsRow} event - The active event's settings row.
 * @returns {Promise<AppointmentTypesLoad>} The types, or the reason they couldn't load.
 */
async function loadAppointmentTypes(
    event: EventSettingsRow,
): Promise<AppointmentTypesLoad> {
    try {
        return { ok: true, types: await getAppointmentTypes(event.code) };
    } catch (err) {
        if (!event.cventAppointmentEventId) {
            return {
                ok: false,
                reason:
                    "This event has no Cvent Appointment Event ID, so its appointment types can't be loaded. " +
                    "Add the ID above, save, and reload this page to map them.",
            };
        }
        return {
            ok: false,
            reason:
                "Cvent couldn't be reached, so this event's appointment types can't be loaded right now. " +
                "The mapping is unchanged, and the other settings still save. " +
                `(${err instanceof Error ? err.message : String(err)})`,
        };
    }
}

/**
 * Renders the Event settings page for the active event.
 *
 * @returns {Promise<JSX.Element>} The page element.
 */
export default async function EventSettingsPage() {
    const { events, activeEventCode } = await getAdminState();
    const active = events.find((e) => e.code === activeEventCode) ?? null;
    const appointmentTypes = active ? await loadAppointmentTypes(active) : null;

    // Key on the active code so the form remounts (resetting its inputs from
    // props) whenever the active event changes — no in-component effect needed.
    return (
        <EventSettingsForm
            key={active?.code ?? "new"}
            active={active}
            hasEvents={events.length > 0}
            appointmentTypes={appointmentTypes}
        />
    );
}
