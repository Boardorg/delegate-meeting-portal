"use client";

import type { Table } from "@tanstack/react-table";

// ---------------------------------------------------------------------------
// TablePagination — the footer beneath an admin table.
//
// Reads page index / count straight off the TanStack table instance and
// drives navigation through `table.previousPage()` / `table.nextPage()`,
// which (in manual mode) fire the table's onPaginationChange — i.e. push the
// new page to the URL. `busy` lets the parent freeze the controls while a
// row mutation is in flight.
// ---------------------------------------------------------------------------

type Props<T> = {
    table: Table<T>;
    /** Total matching rows, for the "N items" summary. */
    total: number;
    /** Singular noun for the summary, e.g. "user" → "12 users". */
    noun: string;
    /** Disable the controls (e.g. while a mutation is pending). */
    busy?: boolean;
};

export function TablePagination<T>({ table, total, noun, busy }: Props<T>) {
    const pageIndex = table.getState().pagination.pageIndex;
    const pageCount = table.getPageCount();
    return (
        <div className="adm-pagination">
            <span className="adm-page-info">
                {total} {noun}
                {total !== 1 ? "s" : ""} · Page {pageIndex + 1} of {pageCount}
            </span>
            <div className="adm-page-btns">
                <button
                    type="button"
                    className="adm-btn"
                    onClick={() => table.previousPage()}
                    disabled={!table.getCanPreviousPage() || busy}
                >
                    ← Prev
                </button>
                <button
                    type="button"
                    className="adm-btn"
                    onClick={() => table.nextPage()}
                    disabled={!table.getCanNextPage() || busy}
                >
                    Next →
                </button>
            </div>
        </div>
    );
}
