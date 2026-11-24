import { emptyPage } from "@/lib/admin/pagination";
import { getActiveEventCode } from "@/lib/admin/globalState";
import { loadAttendees } from "@/lib/attendees/loader";
import {
    DELEGATE_SORT_FIELDS,
    listDelegatesPage,
    type DelegateRow,
    type DelegateSortField,
    type DelegatesPage,
} from "@/lib/admin/delegates";
import DelegatesTable from "./DelegatesTable";

// ---------------------------------------------------------------------------
// /admin/delegates is the Delegates page.
//
// Server component: lists the delegates sponsors see in the frontend catalog
// for the active event, so admins can check who is on offer.
// Search (q), sort and page live in the URL, like /admin/requests.
// The page is read-only. Salesforce and Cvent stay the place to change attendees.
// ---------------------------------------------------------------------------

/**
 * Renders the Delegates page for the active event and view state.
 *
 * @param {{ searchParams: Promise<Record<string, string | undefined>> }} props - Route props.
 * @returns {Promise<JSX.Element>} The page element.
 */
export default async function AdminDelegatesPage({
    searchParams,
}: {
    searchParams: Promise<{
        q?: string;
        sort?: string;
        dir?: string;
        page?: string;
    }>;
}) {
    const sp = await searchParams;
    const selectedEvent = await getActiveEventCode();

    const sortField: DelegateSortField = DELEGATE_SORT_FIELDS.includes(
        sp.sort as DelegateSortField,
    )
        ? (sp.sort as DelegateSortField)
        : "name";
    const sortDir = sp.dir === "desc" ? "desc" : "asc";
    const query = sp.q ?? "";
    const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

    const data: DelegatesPage = selectedEvent
        ? listDelegatesPage(await loadAttendees(false, selectedEvent), {
              q: query,
              sortField,
              sortDir,
              page,
          })
        : emptyPage<DelegateRow>();

    return (
        <DelegatesTable
            selectedEvent={selectedEvent}
            query={query}
            sortField={sortField}
            sortDir={sortDir}
            data={data}
        />
    );
}
