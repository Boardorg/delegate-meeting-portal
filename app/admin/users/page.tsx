import { listUsersPage } from "./actions";
import UsersTable from "./UsersTable";

// ---------------------------------------------------------------------------
// /admin/users — user administration page.
//
// Server component: fetches one page of users at request time and hands it to
// the client-side <UsersTable /> which renders the inline-editable rows and
// invokes the server actions for create/update/delete.
// ---------------------------------------------------------------------------

/**
 * Renders the users-management page.
 *
 * @returns {Promise<JSX.Element>} The page element.
 */
export default async function AdminUsersPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const page = Number(params.page) || 1;
    const data = await listUsersPage({ page });
    return <UsersTable data={data} />;
}
