import {
    listRequestEventCodes,
    listRequestsPage,
    type RequestSortField,
    type RequestsPage,
} from "./actions";
import RequestsTable from "./RequestsTable";

// ---------------------------------------------------------------------------
// /admin/requests — meeting-request administration page.
//
// Server component: all of event, search (q), sort, and page live in the URL
// search params, so each change re-runs this query server-side and the table
// renders one page at a time. The client table (TanStack, manual mode) only
// manages header/sort/pagination interactions and pushes them to the URL.
// ---------------------------------------------------------------------------

const SORT_FIELDS: RequestSortField[] = [
    "requesterName",
    "targetName",
    "rank",
    "createdAt",
    "updatedAt",
];

/**
 * Renders the meeting-requests admin page for the selected event + view state.
 *
 * @param {{ searchParams: Promise<Record<string, string | undefined>> }} props - Route props.
 * @returns {Promise<JSX.Element>} The page element.
 */
export default async function AdminRequestsPage({
    searchParams,
}: {
    searchParams: Promise<{
        event?: string;
        q?: string;
        sort?: string;
        dir?: string;
        page?: string;
    }>;
}) {
    const sp = await searchParams;
    const eventCodes = await listRequestEventCodes();

    const selectedEvent =
        sp.event && eventCodes.includes(sp.event)
            ? sp.event
            : (eventCodes[0] ?? null);

    const sortField: RequestSortField = SORT_FIELDS.includes(
        sp.sort as RequestSortField,
    )
        ? (sp.sort as RequestSortField)
        : "updatedAt";
    const sortDir = sp.dir === "asc" ? "asc" : "desc";
    const query = sp.q ?? "";
    const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

    const data: RequestsPage = selectedEvent
        ? await listRequestsPage({
              eventCode: selectedEvent,
              q: query,
              sortField,
              sortDir,
              page,
          })
        : { rows: [], total: 0, page: 1, pageSize: 25, pageCount: 1 };

    return (
        <RequestsTable
            eventCodes={eventCodes}
            selectedEvent={selectedEvent}
            query={query}
            sortField={sortField}
            sortDir={sortDir}
            data={data}
        />
    );
}
