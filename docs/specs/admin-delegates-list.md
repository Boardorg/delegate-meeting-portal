# Spec: Admin Delegates list

Status: **Draft** (when approved: **Approved by <name>, <YYYY-MM-DD>**)
Author: Mark Woodard
Branch: `feat/admin-delegates-list`
Process: [agent pipeline](../agent-pipeline.md)

The rules in [`AGENTS.md`](../../AGENTS.md) apply. Don't repeat them here.

Note: this was built on the branch before the spec was written. It records what the branch does so it can be approved and reviewed through the pipeline.

## Problem

Sponsor reps see a catalog of delegates on the frontend and request meetings from it.
Admins can't see that list. They can't log in to the frontend, because admins are redirected to `/admin`.
So there is no way for an admin to check which delegates sponsors are being offered for an event, or to find one quickly.

## Decisions

1. **A new read-only admin page lists the catalog delegates.** It lives at `/admin/delegates` with the title "Delegates".
2. **It shows the same delegates sponsors see.** That is every attendee with the `delegate` role who has not cancelled in Cvent.
   The rule lives in one function, `isCatalogDelegate`, which the frontend catalog and the admin page both use, so the two can't drift apart.
3. **The viewer's own company is not filtered out.** The frontend hides a sponsor rep's own company from that rep. That depends on who is looking, so the admin page shows the full list.
4. **It starts with three columns: Name, Company and Email.** None of the catalog's profile details are shown. More columns can be added later.
5. **It works like the other admin tables.** It uses the shared `SortableHeaders` and `TablePagination` components and the `adm-` styles. Search, sort and page live in the URL, as on Sponsor Meeting Requests.
   - Search matches name, company or email, ignoring case and surrounding spaces.
   - Every column sorts. The default is name, A to Z. Ties fall back to name.
   - 25 rows per page, the admin default.
6. **It follows the event picker.** The list is for the active event. With no event, it shows the same "No events found" message as Sponsor Booths.
7. **It sits in the menu under Sponsor Meetings**, after Sponsor Booths, labelled "Delegates". When the Delegate Meetings group arrives (see [admin-menu-and-overview](admin-menu-and-overview.md)), it may move there.
8. **No server action.** The page's server component loads attendees and builds the page directly. Delegate emails are not exposed through a callable action endpoint.

## Scope

### Data

No database changes. Attendees come from `loadAttendees` (Salesforce matched against Cvent, or `data/mock/attendees.json` in mock mode), the same loader the frontend uses.

### Logic

- `lib/attendees/self.ts`: new `isCatalogDelegate(attendee)`, next to `isOwnParty`, the catalog rule from decision 2.
- `app/page.tsx`: the frontend catalog uses `isCatalogDelegate` in place of its inline filter. Its behavior doesn't change.
- `lib/admin/delegates.ts`: new pure `listDelegatesPage(attendees, params)`. It filters with `isCatalogDelegate`, maps to `{ salesforceId, name, company, email }`, searches, sorts and pages with `paginate`. It never changes the array it is given, since `loadAttendees` shares one array per request.

### UI

- `app/admin/delegates/page.tsx`: server component. Reads `q`, `sort`, `dir` and `page` from the URL, falls back to defaults for invalid values, and renders `DelegatesTable`.
- `app/admin/delegates/DelegatesTable.tsx`: client table. TanStack in manual mode, debounced search box, sortable headers, pagination footer. Blank values show as "—".
- `app/admin/nav.tsx`: the "Delegates" menu entry.

## Out of scope

- Profile details, title, phone or Salesforce links.
- Showing cancelled delegates, or a toggle to include them.
- Showing the list as a particular sponsor rep sees it.
- Editing delegates. Salesforce and Cvent stay the place to change attendees.
- Export to CSV.

## Acceptance criteria

Each one must be covered by a unit test unless it is marked manual.

1. Only attendees with the `delegate` role who are not cancelled in Cvent are listed. Sponsor reps and cancelled delegates are not.
2. Each row has the delegate's Salesforce id, name, company and email.
3. With no sort given, rows are sorted by name, A to Z.
4. Sorting by a column in either direction orders by that column, with name breaking ties.
5. Search matches name, company or email, ignoring case and surrounding spaces. No match gives an empty page with a total of 0.
6. Rows are paged. A page past the end is clamped to the last page.
7. Building the list does not reorder the attendee array it was given.
8. **Manual.** The frontend catalog shows the same delegates as before this change.
9. **Manual.** The admin page lists the same delegates a sponsor rep sees on the frontend for the same event, apart from the rep's own company (decision 3).

## Manual check

Steps for a person to run on a preview deployment.

1. Log in as an admin and pick an event. Open **Sponsor Meetings → Delegates**.
2. Check the count in the footer against the number of delegates a sponsor rep sees in the catalog for that event, allowing for any delegates from the rep's own company.
3. Search part of a name, a company and an email. Each should narrow the list. Clear the search and the full list returns.
4. Click each column header to sort both ways. Move to page 2, then reload. The page, sort and search should survive the reload.
5. Switch events with the picker. The list should change to the new event's delegates.
6. Log in as a sponsor rep and confirm the catalog looks the same as before.

## Rollout

1. Nothing to do on deploy day. There are no migrations or settings.
