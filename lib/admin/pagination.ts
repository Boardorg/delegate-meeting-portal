// ---------------------------------------------------------------------------
// Pagination — shared shape + math for the admin tables.
//
// Every admin list endpoint returns one page of rows plus the totals the
// client table needs to render its footer and drive TanStack's manual
// pagination. `paginate()` centralizes the page-size default, the page clamp,
// and the offset calculation so each `listXPage` action is just a count, this
// call, and a sliced/limited query.
// ---------------------------------------------------------------------------

/** Default rows-per-page for admin tables. */
export const DEFAULT_PAGE_SIZE = 25;

/** One page of rows plus the totals the client table needs. */
export type Page<T> = {
    rows: T[];
    total: number;
    page: number;
    pageSize: number;
    pageCount: number;
};

/**
 * Resolves the page-size default, clamps the requested page into range, and
 * derives the SQL `offset` / array slice start.
 *
 * @param {number} total - Total matching rows.
 * @param {{ page?: number; pageSize?: number }} opts - Requested page (1-based) and size.
 * @returns {{ page: number; pageSize: number; pageCount: number; offset: number }}
 *   The clamped page, the effective size, the total page count, and the offset.
 */
export function paginate(
    total: number,
    opts: { page?: number; pageSize?: number } = {},
): { page: number; pageSize: number; pageCount: number; offset: number } {
    const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, opts.page ?? 1), pageCount);
    const offset = (page - 1) * pageSize;
    return { page, pageSize, pageCount, offset };
}

/**
 * Builds an empty page (used when there's nothing to query, e.g. no event
 * selected yet). Keeps the footer math valid without a DB round trip.
 *
 * @param {number} [pageSize=DEFAULT_PAGE_SIZE] - The size to report.
 * @returns {Page<T>} An empty page.
 */
export function emptyPage<T>(pageSize: number = DEFAULT_PAGE_SIZE): Page<T> {
    return { rows: [], total: 0, page: 1, pageSize, pageCount: 1 };
}
