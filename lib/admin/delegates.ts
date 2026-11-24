import type { Attendee } from "@/types";
import { isCatalogDelegate } from "@/lib/attendees/self";
import { paginate, type Page } from "@/lib/admin/pagination";

// ---------------------------------------------------------------------------
// Delegate list for the /admin/delegates page.
//
// Shows admins the delegates that sponsors see in the frontend catalog.
// Attendees come from Salesforce and Cvent, not the database.
// So search, sort and paging run in memory over the event's attendee list.
// ---------------------------------------------------------------------------

/** One row of the admin delegates table. */
export type DelegateRow = {
    /** The delegate's Salesforce id. Used as the row key. */
    salesforceId: string;
    name: string;
    company: string;
    email: string;
};

/** Sortable columns of the delegates table. */
export type DelegateSortField = "name" | "company" | "email";

/** Every sortable column, for validating the URL's sort param. */
export const DELEGATE_SORT_FIELDS: DelegateSortField[] = [
    "name",
    "company",
    "email",
];

/** Search, sort and page for one page of delegates. `page` is 1-based. */
export type ListDelegatesParams = {
    q?: string;
    sortField?: DelegateSortField;
    sortDir?: "asc" | "desc";
    page?: number;
    pageSize?: number;
};

/** A page of delegate rows plus the totals the table needs. */
export type DelegatesPage = Page<DelegateRow>;

/**
 * Builds one page of catalog delegates, searched and sorted.
 * Search matches name, company or email, ignoring case.
 * Ties on the sort column fall back to name so the order is stable.
 *
 * @param {Attendee[]} attendees - The event's attendee list. It is not changed.
 * @param {ListDelegatesParams} [params] - Search, sort and page.
 * @returns {DelegatesPage} The page of rows plus totals.
 */
export function listDelegatesPage(
    attendees: Attendee[],
    params: ListDelegatesParams = {},
): DelegatesPage {
    const sortField = params.sortField ?? "name";
    const dir = params.sortDir === "desc" ? -1 : 1;
    const q = (params.q ?? "").trim().toLowerCase();

    let rows: DelegateRow[] = attendees.filter(isCatalogDelegate).map((a) => ({
        salesforceId: a.salesforceId,
        name: a.name,
        company: a.company,
        email: a.email,
    }));

    if (q) {
        rows = rows.filter(
            (r) =>
                r.name.toLowerCase().includes(q) ||
                r.company.toLowerCase().includes(q) ||
                r.email.toLowerCase().includes(q),
        );
    }

    rows.sort(
        (a, b) =>
            dir * a[sortField].localeCompare(b[sortField]) ||
            a.name.localeCompare(b.name),
    );

    const total = rows.length;
    const { page, pageSize, pageCount, offset } = paginate(total, params);

    return {
        rows: rows.slice(offset, offset + pageSize),
        total,
        page,
        pageSize,
        pageCount,
    };
}
