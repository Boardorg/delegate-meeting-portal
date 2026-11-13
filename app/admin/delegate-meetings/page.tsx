import { emptyPage } from "@/lib/admin/pagination";
import { getActiveEventCode } from "@/lib/admin/globalState";
import {
    d2dRunWarning,
    listDelegatesPage,
    type DelegateRow,
    type DelegateSortField,
    type DelegatesPage,
} from "./actions";
import DelegatesTable from "./DelegatesTable";

// ---------------------------------------------------------------------------
// /admin/delegate-meetings — the delegate list for D2D one-on-ones.
//
// Mirrors /admin/meetings: event, search, sort and page live in the URL,
// so each change re-runs the query server-side.
// ---------------------------------------------------------------------------

const SORT_FIELDS: DelegateSortField[] = ["name", "company", "s2dCount", "d2dCount"];

/**
 * Renders the Delegate Meetings page for the selected event and view state.
 *
 * @param {{ searchParams: Promise<Record<string, string | undefined>> }} props - Route props.
 * @returns {Promise<JSX.Element>} The page element.
 */
export default async function DelegateMeetingsPage({
    searchParams,
}: {
    searchParams: Promise<{ q?: string; sort?: string; dir?: string; page?: string }>;
}) {
    const sp = await searchParams;
    const selectedEvent = await getActiveEventCode();

    const sortField: DelegateSortField = SORT_FIELDS.includes(sp.sort as DelegateSortField)
        ? (sp.sort as DelegateSortField)
        : "name";
    const sortDir = sp.dir === "desc" ? "desc" : "asc";
    const query = sp.q ?? "";
    const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

    const [data, orderWarning]: [DelegatesPage, string | null] = selectedEvent
        ? await Promise.all([
              listDelegatesPage({ eventCode: selectedEvent, q: query, sortField, sortDir, page }),
              d2dRunWarning(selectedEvent),
          ])
        : [emptyPage<DelegateRow>(), null];

    return (
        <DelegatesTable
            selectedEvent={selectedEvent}
            query={query}
            sortField={sortField}
            sortDir={sortDir}
            data={data}
            orderWarning={orderWarning}
        />
    );
}
