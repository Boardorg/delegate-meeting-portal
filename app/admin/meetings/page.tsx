import { emptyPage } from "@/lib/admin/pagination";
import {
    listMeetingsEventCodes,
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
    "name",
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
        event?: string;
        q?: string;
        sort?: string;
        dir?: string;
        page?: string;
    }>;
}) {
    const sp = await searchParams;
    const eventCodes = await listMeetingsEventCodes();

    const selectedEvent =
        sp.event && eventCodes.includes(sp.event)
            ? sp.event
            : (eventCodes[0] ?? null);

    const sortField: SponsorSortField = SORT_FIELDS.includes(
        sp.sort as SponsorSortField,
    )
        ? (sp.sort as SponsorSortField)
        : "company";
    const sortDir = sp.dir === "desc" ? "desc" : "asc";
    const query = sp.q ?? "";
    const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

    const data: SponsorsPage = selectedEvent
        ? await listSponsorsPage({
              eventCode: selectedEvent,
              q: query,
              sortField,
              sortDir,
              page,
          })
        : emptyPage<SponsorRow>();

    return (
        <SponsorsTable
            eventCodes={eventCodes}
            selectedEvent={selectedEvent}
            query={query}
            sortField={sortField}
            sortDir={sortDir}
            data={data}
        />
    );
}
