# Spec: Admin menu and event overview

Status: **Draft** (when approved: **Approved by <name>, <YYYY-MM-DD>**)
Author: Peter Wiley
Branch: `feat/admin-menu-and-overview`
Process: [agent pipeline](../agent-pipeline.md)

The rules in [`AGENTS.md`](../../AGENTS.md) apply. Don't repeat them here.

## Problem

- **"Admin Home" is blank.** `/admin` shows only the text "Admin Main".
- **The menu doesn't show what the event picker controls.** The picker sits above every link, including Users, which isn't tied to an event. Event Settings mixes editing the selected event with creating a new one.
- **Titles are inconsistent.** Some menu labels and page titles are Title Case ("Manage Meetings") and some aren't ("Sponsor booths", "Event settings", "Meeting requests").
- **Sponsor pages don't say they're for sponsors.** The delegate-to-delegate and roundtable pages are coming (see [d2d-and-roundtable-matching](d2d-and-roundtable-matching.md)), so "Manage Meetings" and "Meeting Requests" will be unclear.

## Decisions

1. **The menu follows the "pick a context, then work in it" pattern.** The event picker sits at the top. Everything under it is for the selected event, grouped by area, with Event Settings last. Pages for all events sit below a divider at the bottom.

   ```
   [ Event: NALES ▾ ]
   + New Event
   Overview
   Sponsor Meetings
      Sponsor Meeting Requests
      Sponsor Meetings
      Sponsor Booths
   Event Settings
   ──────────────
   Users
   ```

   The D2D feature later adds a "Delegate Meetings" group after Sponsor Meetings.
2. **Creating an event moves next to the picker.** A "+ New Event" link under the picker opens Event Settings in create mode. The "+ New event" button on Event Settings is removed. Event Settings is then only about the selected event: editing and deleting it.
3. **"Admin Home" becomes "Overview"**, an overview of the selected event at `/admin` (decision 6).
4. **Sponsor pages are renamed.** Only labels and titles change, not routes:

   | Today | New menu label and page title |
   |---|---|
   | Meeting Requests / "Meeting requests" | Sponsor Meeting Requests |
   | Manage Meetings | Sponsor Meetings |
   | Sponsor booths | Sponsor Booths |
   | Event settings | Event Settings |
   | Admin Home | Overview |

   Group headings ("Sponsor Meetings") are labels only, with no link. The child "Sponsor Meetings" links to `/admin/meetings`.
5. **All menu labels, page titles and section headings in the admin use Title Case.** Buttons and help text keep their current wording.
6. **Overview follows the scheduling order for the selected event.** It shows one card per step, each with counts and a link to its page:
   - **Setup:** whether Event Settings has every required field, and whether a Cvent appointment type is mapped to sponsor-to-delegate. Missing items show as warnings linking to Event Settings.
   - **Sponsor Booths:** how many sponsor companies have a booth or package problem, linking to Sponsor Booths.
   - **Sponsor Meeting Requests:** total requests and how many sponsor companies made them.
   - **Sponsor Meetings:** scheduled, pushed (Synced), Modified and Not pushed counts, plus meetings only in Cvent.

   With no event selected, Overview says to pick or create one. If Cvent can't be reached, the cards that need it say so and the rest still load.
7. **Overview reuses existing loaders.** It calls the same server code as the pages it summarizes, so its counts always match them. It adds no database changes.

## Scope

### UI

- `app/admin/nav.tsx`: the new structure, labels and divider (decisions 1 and 4).
- `app/components/AdminSidebar.tsx`: support a group heading with no link (already partly supported) and a divider entry.
- `app/admin/layout.tsx`: the "+ New Event" link under the picker, linking to `/admin/event-settings?new=1`.
- `app/admin/event-settings/`: open in create mode when `?new=1` is present. Remove the "+ New event" button. Title "Event Settings".
- Page titles in `RequestsTable.tsx`, `SponsorsTable.tsx`, `BoothsTable.tsx` and `UsersTable.tsx` (decisions 4 and 5).
- `app/admin/page.tsx`: the Overview page (decision 6), styled like the other admin pages.

### Logic

- One server function that gathers the Overview counts for an event from the existing loaders. Pure helpers turn the loaded data into card counts and warnings, so they can be tested without the database or Cvent.

## Out of scope

- Delegate Meetings, Roundtables and Matching Settings pages. They come with the D2D feature.
- Changing any route.
- Changing what any page does, other than moving "+ New Event".

## Acceptance criteria

Each one must be covered by a unit test unless it is marked manual.

1. The menu matches decision 1, with Users below the divider. (Manual.)
2. Every admin page title and menu label is Title Case and matches the table in decision 4. (Manual.)
3. "+ New Event" opens Event Settings in create mode. Event Settings has no create button of its own.
4. The Overview counts match the Sponsor Meeting Requests, Sponsor Meetings and Sponsor Booths pages for the same event.
5. Overview warns when Event Settings is missing a required field, or when no appointment type is mapped to sponsor-to-delegate.
6. When Cvent can't be reached, Overview still loads, and the Cvent-dependent cards say why they're empty.
7. With no events, Overview says to create one.

## Manual check

1. On a preview, check the menu order, the divider and every title.
2. Switch events in the picker and check Overview updates.
3. Click "+ New Event", then cancel. Check Event Settings goes back to the selected event.
4. Compare Overview's counts with each linked page.

## Rollout

1. No database changes. Deploy as normal.
