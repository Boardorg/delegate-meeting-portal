"use client";

import { flexRender, type Table } from "@tanstack/react-table";

// ---------------------------------------------------------------------------
// SortableHeaders — renders a <thead> from a TanStack table instance.
//
// Each column whose `getCanSort()` is true renders a sort button with an
// up/down indicator; the rest render their header as plain text. Sortability
// is driven entirely by the table config (manualSorting + per-column
// enableSorting), so a table that doesn't wire up sorting (like /admin/users)
// just gets plain headers with no extra props.
// ---------------------------------------------------------------------------

type Props<T> = {
    table: Table<T>;
    /** Column id to flag with the actions-column width class. */
    actionsColumnId?: string;
};

export function SortableHeaders<T>({
    table,
    actionsColumnId = "actions",
}: Props<T>) {
    return (
        <thead>
            {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                    {hg.headers.map((header) => {
                        const canSort = header.column.getCanSort();
                        const sorted = header.column.getIsSorted();
                        const label = flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                        );
                        return (
                            <th
                                key={header.id}
                                className={
                                    header.column.id === actionsColumnId
                                        ? "adm-actions-col"
                                        : undefined
                                }
                            >
                                {canSort ? (
                                    <button
                                        type="button"
                                        className="adm-sort-btn"
                                        onClick={header.column.getToggleSortingHandler()}
                                    >
                                        {label}
                                        <span className="adm-sort-ind">
                                            {sorted === "asc"
                                                ? "↑"
                                                : sorted === "desc"
                                                  ? "↓"
                                                  : ""}
                                        </span>
                                    </button>
                                ) : (
                                    label
                                )}
                            </th>
                        );
                    })}
                </tr>
            ))}
        </thead>
    );
}
