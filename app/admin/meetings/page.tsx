import { emptyPage } from "@/lib/admin/pagination";
import { getActiveEventCode } from "@/lib/admin/globalState";
import {
    listSponsorsPage,
    type SponsorRow,
    type SponsorSortField,
    type SponsorsPage,
} from "./actions";
import SponsorsTable from "./SponsorsTable";

// ---------------------------------------------------------------------------
// /admin/meetings — sponsor list for the Manage Meetings section.
//
// Server component: event, search, sort, and page all live in the URL so
// each change re-runs the query server-side. The client table (TanStack,
// manual mode) only handles header/sort/pagination interactions and pushes
// them back into the URL.
// ---------------------------------------------------------------------------

const SORT_FIELDS: SponsorSortField[] = [
    "company",
    "tier",
    "requestCount",
    "scheduledCount",
];

/**
 * Renders the Manage Meetings admin page for the selected event and view state.
 *
 * @param {{ searchParams: Promise<Record<string, string | undefined>> }} props - Route props.
 * @returns {Promise<JSX.Element>} The page element.
 */
export default async function AdminMeetingsPage({
    searchParams,
}: {
    searchParams: Promise<{
        q?: string;
        sort?: string;
        dir?: string;
        page?: string;
    }>;
}) {
    // Get query parameters from the URL.
    const sp = await searchParams;

    // The active event is global (cookie-backed), shared with the sidebar switcher.
    const selectedEvent = await getActiveEventCode();

    // Validate and sanitize other query parameters for search, sort, and pagination.
    const sortField: SponsorSortField = SORT_FIELDS.includes(
        sp.sort as SponsorSortField,
    )
        ? (sp.sort as SponsorSortField)
        : "company";
    const sortDir = sp.dir === "desc" ? "desc" : "asc";
    const query = sp.q ?? "";
    const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

    // Fetch the sponsor data for the selected event and query parameters.
    const data: SponsorsPage = selectedEvent
        ? await listSponsorsPage({
              eventCode: selectedEvent,
              q: query,
              sortField,
              sortDir,
              page,
          })
        : emptyPage<SponsorRow>();

    // Render the sponsor table with the fetched data and query parameters.
    return (
        <SponsorsTable
            selectedEvent={selectedEvent}
            query={query}
            sortField={sortField}
            sortDir={sortDir}
            data={data}
        />
    );
}
