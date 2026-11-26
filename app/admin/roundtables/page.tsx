import { getActiveEventCode } from "@/lib/admin/globalState";
import { loadEventScheduleData } from "@/lib/cvent/mapper";
import { listRoundtables, type RoundtablesOverview } from "./actions";
import RoundtablesTable from "./RoundtablesTable";

// ---------------------------------------------------------------------------
// /admin/roundtables: the roundtable list for the selected event.
//
// Mirrors /admin/meetings. One row per roundtable, with the unassigned delegates below.
// ---------------------------------------------------------------------------

const EMPTY: RoundtablesOverview = { rows: [], unassigned: [], cventTables: [], orderWarning: null };

/**
 * Renders the Roundtables page for the selected event.
 *
 * @returns {Promise<JSX.Element>} The page element.
 */
export default async function RoundtablesPage() {
    const selectedEvent = await getActiveEventCode();
    const [data, schedule] = selectedEvent
        ? await Promise.all([listRoundtables(selectedEvent), loadEventScheduleData(selectedEvent)])
        : [EMPTY, null];
    return <RoundtablesTable selectedEvent={selectedEvent} data={data} timezone={schedule?.timezone ?? "UTC"} />;
}
