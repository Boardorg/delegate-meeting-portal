import { listUsers } from "./actions";
import UsersTable from "./UsersTable";

// ---------------------------------------------------------------------------
// /admin/users — user administration page.
//
// Server component: fetches the user list at request time and hands it to
// the client-side <UsersTable /> which renders the inline-editable rows and
// invokes the server actions for create/update/delete.
// ---------------------------------------------------------------------------

/**
 * Renders the users-management page.
 *
 * @returns {Promise<JSX.Element>} The page element.
 */
export default async function AdminUsersPage() {
    const users = await listUsers();
    return <UsersTable users={users} />;
}
