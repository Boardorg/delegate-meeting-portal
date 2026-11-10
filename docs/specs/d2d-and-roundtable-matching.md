# Spec: Delegate-to-delegate and roundtable matching

Status: **Draft** (when approved: **Approved by <name>, <YYYY-MM-DD>**)
Author: Peter Wiley
Branch: `feat/d2d-and-roundtable-matching`
Process: [agent pipeline](../agent-pipeline.md)

The rules in [`AGENTS.md`](../../AGENTS.md) apply. Don't repeat them here.

## Problem

The portal currently only schedules sponsor-to-delegate (S2D) meetings. The event team schedules two more kinds by hand today.

- **Delegate-to-delegate (D2D) one-on-ones.** Two delegates with similar interests meet in a 20-minute slot. Today this is done in Meetmax and modified by hand.
- **Group roundtables.** Delegates left with no meetings at all are seated at themed discussion tables. Today Justin exports a report, groups people with AI, and adds them to Meetmax by hand.

Meetmax is going away, so both have to move into the portal and sync with Cvent (support pushing, modifying, removing meetings).
Delegates never log in to the portal. The only matching data is each delegate's Networking Profile answers.
Delegates can still book each other directly in the Cvent event app. That happens outside the portal.

Sources:
- The D2D and Group Meeting Matching scoping meeting (Haley, Jax, Justin, Sabrina, Laura, Mark, Peter).
- Justin's roundtable requirements, "Executive Roundtable Matching: Developer Requirements".
- Justin's approval of the "group first, theme after" roundtable flow.
- The NAMLS Networking Profile Gravity Forms export, 2026-11-09.

The first event to use this is NALES (20–21 Jan 2027). Meetings are scheduled about 3 weeks out, so this must be ready by the end of December.

## Decisions

**Order and eligibility**

1. **Scheduling runs in a fixed order: S2D, then D2D, then roundtables.** The D2D engine only runs after S2D meetings are scheduled. The roundtable engine only runs after D2D. Each engine treats every meeting already scheduled as busy time. The portal warns, but doesn't block, if an admin runs them out of order.
2. **D2D is only for delegates who completed the Networking Profile form.** Delegates who didn't are never matched for D2D.
3. **Roundtables are for delegates with zero meetings.** A delegate qualifies when they have no S2D and no D2D meeting in the portal or in Cvent. Cvent is the source of truth for "confirmed" (Cvent-only appointments count, as on the meeting pages today).
4. **No two people from the same company** are paired for D2D or seated at the same roundtable. Company names are compared after normalizing (trimmed, case-insensitive, by Account id when we have one).

**Matching on profile answers**

5. **Only multiple-choice answers are used.** Free-text answers are ignored. No other Salesforce data is used for now.
6. **The matchable questions are a fixed list in code.** Each entry names the profile field and how two answers are compared:

   | Question | Field | Compared by |
   |---|---|---|
   | Areas of interest for one-to-ones | `One_to_One_Interests` | Shared choices |
   | Topics closest to your current focus | `Current_Focus_Topics` | Shared choices |
   | One initiative you'd fund in 24 months | `Initiative_Priority` | Same answer |
   | Systems and platforms you use today | `Systems_and_Platforms` | Shared choices |
   | Transformation stage | `Transformation_Stage` | How close the stages are |
   | Company size | `Company_Size` | How close the bands are |
   | Annual revenue | `Annual_Revenue` | How close the bands are |
   | Personal budget responsibility | `Budget_Responsibility` | How close the bands are |

   Adding a brand-new question needs a small code change. Changing priorities does not (decision 7).
   The form has no Industry question, so Justin's "industry breaks ties" rule uses company size and revenue for now.
7. **Admins set question priority per event on a Matching settings page.** For D2D and for roundtables separately, admins can turn each question on or off and drag them into priority order. Higher questions count for more. Each event starts from these defaults: areas of interest, focus topics, initiative, systems, transformation stage, then company size and revenue as tie-breakers.
8. **Profile completeness counts.** Of two equally good matches, the delegate who answered more questions is preferred, as per Justin's doc.
9. **Every match is explainable.** Each D2D pair and each roundtable shows what the people have in common, for example "Both: Leadership Development, Workday".
10. **Weak matches are flagged, not forced.** A pair or table below the minimum score is still allowed but marked "weak match" for an admin to review. A delegate with no acceptable match stays unmatched and is listed in the run report.

**D2D one-on-ones**

11. **Each delegate's meeting cap counts S2D and D2D together.** A delegate with no S2D meetings gets up to 4 meetings in total, all D2D. A delegate with S2D meetings can have up to 5 in total. Both numbers can be changed per event.
12. **D2D prefers Day 1.** The engine fills Day 1 D2D slots first and puts at most one of a delegate's D2D meetings on Day 2. This keeps delegates in the exhibit hall on both days, as Jax does by hand today.
13. **D2D only uses slots mapped to `delegate_delegate`** in Event settings. They are the same 7 times as S2D slots, at different locations.
14. **Pairing is greedy by score.** The engine scores every eligible pair, then books the best pairs first into the earliest slot both are free, until caps or slots run out. A delegate is never double-booked, including against S2D meetings.
15. **One delegate is the Cvent host, the other is the attendee.** The host is whichever has the lower Salesforce id, so re-runs are stable.

**Roundtables**

16. **The roundtables come from Cvent.** Each event sets up 4 roundtable locations in Cvent, each with a timeslot whose appointment type is mapped to `delegate_group`. For NALES that is 2 on Day 1 and 2 on Day 2. The portal reads them and treats each location's timeslot as one roundtable, so there is no table count to set in the portal. Each roundtable seats 5 delegates. Seats per table is a setting, starting at 5.
17. **Group first, admin creates themes after.** Justin approved this flow. The engine groups eligible delegates into one group per roundtable by shared answers. The portal then shows what each group has in common. Admins edit the groups and enter each table's theme title before pushing.
18. **Each table gets 2 recommended alternates.** They are the next-best fits for that group. They are listed in the portal only and never pushed to Cvent. An admin can swap one into a seat, and the swap is checked against decision 4 and the delegate's busy time.
19. **Extra delegates go on an unassigned list.** If more delegates qualify than there are seats, the rest are reported as unassigned. If too few qualify to fill a table, the table is flagged as short.
20. **Admins can move delegates by hand.** Moving a delegate between tables, or from the unassigned list, re-checks decision 4 and the delegate's busy time, and warns before saving.
21. **The theme title syncs to Cvent.** On push, the title becomes the appointment's `subject`, which Cvent shows on the calendar. The optional moderator prompt goes in the appointment's `description`. Changing either after a push marks the roundtable Modified, and the next push updates Cvent in place.
22. **A staff moderator hosts each roundtable in Cvent.** Admins pick the moderator per table from people registered in the appointment event. Push is blocked for a table with no moderator, with a clear message.

**Push and emails**

23. **D2D and roundtables reuse the existing push.** Synced, Modified and Not pushed work as they do for S2D. Unpush and Remove cancel in Cvent with notifications suppressed (`CVENT_SUPPRESS_NOTIFICATIONS`).

## Scope

### Cvent setup (operations, not code)

- In each event's Appointment Event, create D2D timeslots and locations under "Delegate to Delegate Meetings", at the same 7 times as S2D.
- Create the roundtable timeslots under "Delegate Group Meetings", with one location per table: 2 tables at the first afternoon break on Day 1, and 2 in the first slot on Day 2.
- Map both types in the portal's Event settings: `delegate_delegate` and `delegate_group`.
- Put every delegate and moderator in the "For appointment scheduling" group.

### Data

- `event_settings.matching_settings` (new nullable `jsonb`): the D2D and roundtable question order and on/off switches (decision 7), the meeting caps (decision 11), seats and alternates per table (decisions 16 and 18), and the minimum match scores (decision 10). Null means the code defaults.
- `scheduled_meetings` stores D2D meetings. `attendee_a` is the host delegate and `attendee_b` the other delegate. The "attendee_a is always the sponsor" note in the schema and in `types/index.ts` becomes "attendee_a is the sponsor company on an S2D meeting".
- New table `roundtables`: event, timeslot, location, theme title, moderator prompt, moderator contact, Cvent appointment id, last modified, last pushed. One row per table.
- New table `roundtable_seats`: roundtable, delegate, seated or alternate, position, why they were picked and their match score.
- Generate the migration with `npm run db:generate`. A person applies it to each database by hand before deploy.
- Read the "networking profile complete" flag on each delegate (decision 2). See open question 1.

### Logic

- `lib/matching/questions.ts`: the matchable question list and comparison rules (decision 6). Pure.
- `lib/matching/score.ts`: scores two delegates, or a delegate against a group, using an event's settings, and returns the score with the shared answers that explain it. Pure.
- `lib/matching/d2d.ts`: the D2D engine (decisions 11 to 15). It takes delegates, busy times, slots and settings, and returns meetings and an unmatched list. Pure.
- `lib/matching/roundtables.ts`: the roundtable grouping engine (decisions 16 to 19). It returns groups, alternates, shared-interest summaries and an unassigned list. Pure.
- Server actions to run each engine for an event. Each run replaces the unpushed results of its own kind and keeps pushed ones, as the S2D run does.
- The existing request-based D2D passes 6 and 7 in `lib/scheduling/engine.ts` are removed. Delegates never make requests in the portal, so they never run.
- Push: send D2D meetings as `delegate_delegate`, and roundtables as `delegate_group` with subject, description, moderator host and seated delegates.

### UI

Both new meeting pages mirror the sponsor meetings page (`app/admin/meetings/`, titled "Manage Meetings" or "Sponsor Meetings"): the same layout, components and styles, the same header buttons, the same report panels, and a list page that opens a detail page. Reuse its components where they fit rather than copying them. All page titles and menu labels use Title Case.

- **Matching Settings** (new page, per event): question priority lists for D2D and roundtables, the caps, and seats and alternates per table. It also lists the roundtables found in Cvent, so admins can check all 4 are set up.
- **Delegate Meetings** (new page, mirrors the sponsor meetings page):
  - Header buttons: "Run D2D Matching", "Push All to Cvent", "Unpush All Synced" and "Clear All Unsynced", with the same confirmations. The run opens a report panel like the scheduler's: matched, unmatched and weak matches.
  - The list has one row per eligible delegate, with search. Columns: delegate, company, S2D meetings, D2D meetings scheduled out of their cap, and sync status.
  - Clicking a delegate opens their detail page, like a sponsor's. Its meetings table shows each D2D meeting: the other delegate and company, what they share, time, location, sync status and source. S2D meetings are shown read-only for context. Edit, Remove and Push work as on a sponsor's page. Admins can move a meeting to another slot or remove it, but can't pair two people by hand in this version.
- **Roundtables** (new page, mirrors the sponsor meetings page):
  - Header buttons: "Run Roundtable Grouping", "Push All to Cvent", "Unpush All Synced" and "Clear All Unsynced". The run opens a report panel listing tables, weak or short tables, and unassigned delegates.
  - The list has one row per roundtable. Columns: table (location), day and time, theme title, seats filled out of 5, moderator, and sync status. Below it is the unassigned list.
  - Clicking a table opens its detail page. It has the theme title, moderator prompt and moderator fields, a table of seated delegates with what they share, and the alternates. Delegates can be moved between tables, alternates and unassigned. Push and Unpush work as on a sponsor's page.
- **Sponsor pages say they're for sponsors.** Their titles must be "Sponsor Meeting Requests", "Sponsor Meetings" and "Sponsor Booths". The [admin menu and overview](admin-menu-and-overview.md) spec makes this change. If it isn't merged when this is built, make the renames here, changing only labels and titles, not routes. Otherwise the sponsor pages are unchanged, except that a delegate's meeting count includes their D2D meetings.
- **Admin menu:** add Delegate Meetings, Roundtables and Matching Settings to `app/admin/nav.tsx`, in that order, after the sponsor pages and before Event Settings. If the menu has groups, put them in a "Delegate Meetings" group. If it's a flat list, add them as three links.

## Out of scope

- Delegates requesting specific delegates. Those requests happen in the Cvent app.
- Delegate logins.
- Writing themes, prompts or "conversation DNA" with AI. Admins type them in.
- Industry as a match factor, until the form asks for it.
- Free-text answers.
- Salesforce data other than the Networking Profile answers.

## Open questions

1. **Where does "networking profile complete" live?** It isn't a checkbox on `CventEvents__Attendee__c` in Salesforce, checked 2026-11-10. If it's only on the Cvent attendee record, the portal must read it from Cvent. If neither is practical, we fall back to "answered at least one matchable question".
2. **Does the D2D cap need a per-day limit as well?** For example, at most 3 on Day 1. Decision 12 only limits Day 2.
3. **Who are the moderators for each event,** and are they registered in the appointment event?
4. **Themes and print.** In the scoping meeting Jax said themes go to marketing for print about 9 weeks out. Justin approved grouping first, so confirm that print uses theme titles typed in the portal later, or that the printed themes are copied in.

## Acceptance criteria

Each one must be covered by a unit test unless it is marked manual.

**Settings and scoring**
1. With no saved settings, an event uses the default question order, caps, seats and alternates.
2. Turning a question off removes it from scoring. Moving it up raises how much it counts.
3. Two delegates who share more answers on higher-priority questions score higher than two who share fewer.
4. Free-text and "Undisclosed" or "Other" answers never count as shared.
5. The explanation for a match lists exactly the shared answers that gave it points.

**D2D**
6. Only delegates with a completed profile are matched.
7. No pair has two people from the same company.
8. A delegate with no S2D meetings gets at most 4 meetings. A delegate with S2D meetings gets at most 5 in total.
9. No delegate is booked twice in one slot, including against their S2D meetings and Cvent-only appointments.
10. Day 1 slots are used first, and no delegate gets more than one D2D meeting on Day 2.
11. Only `delegate_delegate` slots are used.
12. A pair below the minimum score is marked weak. A delegate with no acceptable partner is listed as unmatched.
13. Re-running replaces unpushed D2D meetings and keeps pushed ones.

**Roundtables**
14. Only delegates with no S2D or D2D meetings, in the portal or in Cvent, are grouped.
15. Each Cvent location with a `delegate_group` timeslot becomes one roundtable. With 4 of them and 5 seats each, at most 20 delegates are seated. The rest are unassigned.
16. No table seats two people from the same company.
17. Each table gets 2 alternates, and no delegate is in more than one table.
18. Moving a delegate onto a table that already has someone from their company is refused with a message.
19. Push sends the theme title as `subject`, the prompt as `description`, the moderator as host and only the seated delegates as attendees.
20. Changing a pushed roundtable's theme marks it Modified, and re-pushing updates the same Cvent appointment.
21. Push refuses a table with no moderator or no theme title, with a message.

**Order**
22. Running D2D before any S2D meetings exist shows a warning but still runs.

## Manual check

On a preview deployment with test data only:

1. Set the D2D and roundtable question order on Matching settings, then reload and check it saved.
2. Run S2D scheduling for the test sponsors, then run D2D matching. Check the pairs, shared answers, caps and Day 1 preference.
3. Run roundtable grouping. Check that only delegates with no meetings are seated, and look at the shared-interest summary for each table.
4. Move a delegate, swap in an alternate, and enter themes, prompts and moderators.
5. Push. In Cvent, check the D2D and roundtable appointments, their types, hosts, and that roundtable subjects show the themes.
6. Change a theme, re-push, and check Cvent updates in place. Unpush, and check no emails are sent.

## Rollout

1. Apply the migration by hand to each database before deploy.
2. Set up the Cvent timeslots, locations and appointment group (see Cvent setup).
3. In Event settings, map the D2D and roundtable appointment types.
4. Set the question priorities on Matching settings, using Jon Ellis and Brian Walsh's ranking.
5. For NALES: run S2D, then D2D, then roundtables, about 3 weeks before the event.
