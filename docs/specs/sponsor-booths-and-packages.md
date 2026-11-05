# Spec: Sponsor booths and meeting packages

Status: **Approved by Peter, 2026-11-04**
Owner: Peter Wiley
Branch: `feat/sponsor-booths-and-packages`
Process: [agent pipeline](../agent-pipeline.md)

The rules in [`AGENTS.md`](../../AGENTS.md) apply. Don't repeat them here.

## Problem

Three things the scheduler gets wrong today, all checked against live NALES data on 2026-11-04.

**1. Sponsors can meet in any booth.**
Each sponsor company is assigned one booth, and only that company may host meetings there.
The scheduler ignores this. It books a sponsor meeting into the first free `sponsor_delegate` slot at any location.
Booth 13 holds 12 appointments from several companies, two at each time, because its Cvent "Max. appointments allowed at same time" is 2.
The booth assignment already lives in Salesforce, in `Booth_No__c` on the sponsor Opportunity.
Cvent's NALES booths are locations named "Booth 1" to "Booth 30".

**2. Meeting counts are guessed from the package name.**
The portal never reads a meeting count from Salesforce.
A package name containing "diamond" gives 8 meetings, and anything else gives 5 (`lib/attendees/caps.ts`, and `SPONSOR_CAPS` in `lib/scheduling/engine.ts`). Bonus meetings are always 0.
No NALES package contains "diamond", so every NALES sponsor is capped at 5, whatever they bought.
Exhibitor-only sponsors with no meetings in their package also get 5.
These number fields on Opportunity hold the counts:

| Field | Meaning |
|---|---|
| `Meetings__c` | Meetings in the package. This field already existed, and ops already fills it in. At NALES it holds 2 to 7, and 0 for exhibitors with no meetings. |
| `Cvent_Bonus_Meetings__c` | Extra meetings on top of the package. New. |
| `Cvent_Maximum_Meetings__c` | The total the sponsor may have. New. |
| `Cvent_Number_Diaries__c` | How many meetings the sponsor may hold at the same time. New. |

**3. One company can show up as several, and some packages need two meetings at once.**
The portal groups sponsor reps into a company by each rep's **Contact** account.
The booth and the meeting fields live on the **Opportunity**.
7 of the 44 active NALES sponsor reps have a Contact account that differs from their Opportunity's account. Real examples are the 2U rep on edX Enterprise's Opportunity, and two Hult EF reps whose Contacts sit on "Efekta" and "EF Corporate Learning". Each of these shows up in the portal as a separate sponsor company with no package of its own.
Separately, some packages allow two meetings at once at the sponsor's booth.
The scheduler treats a company as busy once it has one meeting at a start time, so it can never give a company two meetings at the same time.
Push makes every rep a host on every appointment, and Cvent rejects a host who is already in another appointment at that time.

## Decisions

1. **A sponsor company is its Opportunity's account.** Sponsor reps are grouped by `Registration__r.AccountId`, not by `Delegate__r.AccountId`. The company name is `Registration__r.Account.Name`. Delegates are unchanged.
2. **Meeting counts come from Salesforce, with the tier as a fallback.** A company's maximum is worked out in this order:
   - `Cvent_Maximum_Meetings__c`, when it is set.
   - Otherwise `Meetings__c` plus `Cvent_Bonus_Meetings__c`, when either is set. A blank one counts as 0.
   - Otherwise, when all three are blank, the tier count used today. That is 8 for diamond and 5 for everyone else.

   A blank field and a 0 mean different things. A 0 that leaves the maximum at 0 means the company gets no meetings. Only blank fields fall back to the tier. The scheduler and the admin screens both use this one rule, so the tier counts live in one place.
3. **The diamond tier still comes from the package name.** It controls the Day 2 spillover rule from the appointment-type spec. It sets a meeting count only through the fallback in decision 2.
4. **Every pass cap is a share of the company's maximum.** Today's diamond pattern (3, 4, 6, 8, 8 out of 8) becomes the rule for every sponsor:

   | Pass | Books | Sponsor cap |
   |---|---|---|
   | 1 | Mutual requests | 37.5% of max |
   | 2 | Sponsor high-interest requests | 50% of max |
   | 3 | Delegate high-interest requests | 75% of max |
   | 4 | Mutual requests, second pass | max |
   | 5 | Everything left | max |

   Each share rounds up, and is at least 1 when the max is above 0. For example a max of 8 gives 3, 4, 6, 8, 8 (the same as today's diamond). A max of 5 gives 2, 3, 4, 5, 5. A max of 2 gives 1, 1, 2, 2, 2. Delegate caps are unchanged.
5. **Each company meets only at its booth.** A company's `Booth_No__c` is turned into a Cvent location in this order:
   - An admin's manual mapping for that booth number, when there is one (decision 12).
   - Otherwise the Cvent location whose name is "Booth " followed by that value, ignoring case and spaces at the ends. A value that already reads "Booth 3" also matches "Booth 3".

   The scheduler only books a company's meetings into `sponsor_delegate` slots at that location. The Day 1 first, Day 2 for diamond rule still applies.
6. **Booth problems stop that company's meetings, not the run.** A company gets no meetings, and the run report says why, when any of these hold:
   - `Booth_No__c` is blank (`no_booth`).
   - It has no manual mapping and matches no Cvent location by name (`booth_not_found`).
   - Its manual mapping points to a location Cvent no longer returns (`booth_not_found`).
   - Another company claims the same booth (`booth_conflict`). Neither company gets meetings until it is fixed.
   - The company's reps are on more than one Opportunity for the event (`multiple_opportunities`).
   - Decision 2 gives it 0 meetings (`no_package_meetings`).
7. **Meetings at once.** A company may hold up to N meetings at the same start time. N is the smallest of `Cvent_Number_Diaries__c` (blank counts as 1) and the number of the company's reps who can host in Cvent (linked and not cancelled). Cvent's own per-slot limit still applies on top, as today. A delegate still has one meeting at a time.
8. **Each rep hosts one meeting at a time.** When a company has one meeting at a start time, all its reps who can host are hosts, as today. When it has more than one, push splits the reps across those meetings. It orders the meetings by meeting id and the reps by Salesforce id, then deals the reps out in turn, so each meeting gets at least one rep and no rep is on two. The split counts every meeting the company has at that time in the portal, pushed or not, so it gives the same answer each time push runs.
9. **Pre-existing Cvent appointments count toward meetings at once.** When the scheduler seeds busy times from Cvent, a company's busy time becomes a count per start time instead of a yes or no.
10. **Admins can't put a sponsor meeting in another company's booth.** In the Edit and Create Meeting windows, a sponsor's own booth slots come first. Slots at a booth assigned to a different company are not offered. Slots at any other location are still offered, with a warning naming the location.
11. **A new admin page shows each company's setup.** Salesforce stays the place to change booth numbers and meeting counts, so those are read-only here. The page links each row to its Opportunity in Salesforce.
12. **Admins can map a booth number to a Cvent location by hand.** The mapping is per event and keyed by the booth number, not the company. Salesforce still decides which company has which booth. The portal only learns which Cvent location a booth number means.
    - Each row on the booths page has a dropdown of the event's Cvent locations that have `sponsor_delegate` slots. It shows the automatic match until an admin picks something else.
    - Picking a location saves the mapping. A "Use automatic match" option removes it.
    - The checks in decision 6 run after mapping. Two booth numbers mapped to the same location are a `booth_conflict`.

## Scope

### Data

- New nullable `jsonb` column `booth_locations` on `event_settings`, for decision 12. It maps a booth number to a Cvent location id, for example `{ "3": "a1c30445-…" }`. Booth numbers are stored trimmed.
- Generate the migration with `npm run db:generate`. It must be applied to each database by hand before deploy, as with `appointment_type_kinds`. Note this in the PR.
- Every other new value is read from Salesforce on each attendee load.
- Add to the sponsor query in `lib/salesforce/client.ts`:
  - `Registration__c`
  - `Registration__r.AccountId`
  - `Registration__r.Account.Name`
  - `Registration__r.Booth_No__c`
  - `Registration__r.Meetings__c`
  - `Registration__r.Cvent_Bonus_Meetings__c`
  - `Registration__r.Cvent_Maximum_Meetings__c`
  - `Registration__r.Cvent_Number_Diaries__c`
- Sponsor attendees in `types/index.ts` gain `opportunityId`, `boothNo`, `purchasedMeetings`, `bonusMeetings`, `maximumMeetings` and `meetingsAtOnce`, each nullable. `lib/salesforce/attendeeMapper.ts` fills them, with `purchasedMeetings` read from `Meetings__c`. It also sets `accountId` and `company` from the Opportunity's account for sponsors (decision 1, see the [Decisions](#decisions) section above).
- Extend `data/mock/attendees.json` with sponsors that cover every case in decisions 2, 6 and 7. Extend `data/mock/cvent/locations.json` and `available-times.json` with booth locations to match.

### Logic

- `lib/attendees/companies.ts`: a sponsor company carries its Opportunity id, booth, meeting counts, maximum and meetings at once, resolved once from its reps. A company whose reps disagree on Opportunity is marked for decision 6.
- `lib/attendees/caps.ts`: replace `contractedMeetings(tier)` with a function that takes a company and returns its maximum and where it came from (decision 2). The tier counts for the fallback live only here.
- New `lib/scheduling/booths.ts`: pure functions that match a company to its booth location, using the manual mapping first (decisions 5 and 12), and list the problems in decision 6. The engine, the editor and the admin page all use them.
- A server action on the booths page saves or removes one booth mapping. It rejects a location id that isn't one of the event's Cvent locations, and returns that error instead of throwing.
- `lib/scheduling/engine.ts`:
  - Remove `SPONSOR_CAPS` and `tierCap`, and compute pass caps from the maximum (decision 4).
  - Only book a company into slots at its booth (decision 5), and skip companies with a booth problem (decision 6).
  - Track busy times per party as a count per start time, allowing up to N for a sponsor company and 1 for a delegate (decisions 7 and 9).
  - Keep the diamond spillover tied to tier (decision 3).
- `lib/scheduling/helpers.ts`: `findAvailableTimeslot` takes the allowed location and the at-once limit.
- `lib/scheduling/report.ts`: add the new failure reasons from decision 6.
- `app/admin/meetings/actions.ts`: build the company booth data before a run. Pass the count of companies with problems to the run warning.
- `lib/cvent/push.ts`: choose hosts per decision 8.

### UI

- New admin page `app/admin/booths/page.tsx`, listed in the admin sidebar as "Sponsor booths". One row per sponsor company with:
  - its reps, and how many can host in Cvent
  - Booth No. from Salesforce
  - a Cvent location dropdown (decision 12). It shows the manual mapping, or the automatic match, or "No match", and says which one it is.
  - the booth's Cvent per-slot limit
  - purchased, bonus and maximum meetings, and meetings at once
  - any problem from decision 6
  - a warning when meetings at once is more than the booth's Cvent limit, or more than the reps who can host
  - a warning when `Cvent_Maximum_Meetings__c` differs from purchased plus bonus
  - a "from tier" note when the maximum comes from the fallback in decision 2
- Manage Meetings: replace "Contracted" with "Purchased", and fill "Bonus" from Salesforce. Targets use the maximum. Show the same numbers on the sponsor page's stat chips.
- "Run Scheduling Engine" warns before running when any company has a booth problem, and links to the booths page.
- The Edit and Create Meeting windows filter slots per decision 10.

## Out of scope

- Editing booth numbers or meeting counts in the portal. Salesforce stays the source. Only the booth number to Cvent location mapping is edited here.
- Delegate-to-delegate and group meetings.
- Letting admins choose which rep hosts which meeting.
- Sponsor reps the portal drops because their email isn't a Cvent registrant, such as Jane Smith on the Match Made in Heaven test sponsor.
- Moving appointments already in Cvent to the right booth. That is a rollout step.

## Acceptance criteria

Each one must be covered by a unit test unless it is marked manual.

**Companies and counts**

1. Two reps whose Contacts are on different accounts but who share one Opportunity become one company, named for the Opportunity's account.
2. A company's maximum is `Cvent_Maximum_Meetings__c` when set, otherwise purchased plus bonus when either is set.
3. When all three fields are blank, a diamond company's maximum is 8 and any other company's is 5.
4. A company whose fields give a maximum of 0 gets no meetings, and the report says `no_package_meetings`. It does not fall back to the tier.
5. A company with a "DIAMOND" package and a maximum of 4 never gets more than 4 meetings, and can still spill over to Day 2.
6. Pass caps follow decision 4. A maximum of 5 gives 2, 3, 4, 5, 5 and a maximum of 2 gives 1, 1, 2, 2, 2.

**Booths**

7. Booth No. "3" and "Booth 3" both match the Cvent location "Booth 3". "3" does not match "Booth 13".
8. A manual mapping for booth number "3" wins over the automatic match. Removing it brings the automatic match back.
9. Saving a mapping to a location id the event doesn't have returns an error and saves nothing.
10. A manual mapping to a location Cvent no longer returns gives `booth_not_found`.
11. Two booth numbers mapped to the same location give `booth_conflict` for both companies.
12. The scheduler never books a company into a slot at any location other than its booth, even when such a slot is free and earlier.
13. Each case in decision 6 gives that company no meetings and the matching report reason. Other companies still get scheduled.
14. When two companies claim the same booth, neither gets meetings.

**Meetings at once**

15. A company with Diaries 2 and two reps can get two meetings at the same start time at its booth, up to Cvent's per-slot limit.
16. A company with Diaries 2 but only one rep who can host never gets two meetings at the same time.
17. A blank Diaries field allows one meeting at a time.
18. A delegate never gets two meetings at the same start time.
19. Appointments already in Cvent count toward a company's meetings at once.

**Push**

20. A company with one meeting at a start time pushes it with all reps who can host.
21. A company with two meetings at the same start time and three reps pushes them with reps split per decision 8. No rep is a host on both. Pushing again gives the same split.

**Admin**

22. The booths page lists every sponsor company with the values and warnings in the UI section.
23. Manage Meetings and the sponsor page show purchased, bonus and maximum from Salesforce. They use the same rule as the scheduler, including the tier fallback.
24. The Edit and Create Meeting windows never offer a slot at another company's booth.
25. "Run Scheduling Engine" warns when any company has a booth problem.

**Overall**

26. All existing tests still pass. `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass, as in CI.
27. *(Manual, by Peter)* The preview checks below all pass.

## Manual check (Peter, on a Vercel preview)

The three NALES test sponsors are set up in Salesforce for this:

| Sponsor | Booth | Max | Diaries | Reps |
|---|---|---|---|---|
| 21 Montopolis [TEST] | 2 | 5 | 2 | Bob Johnson, Ted Stefandis |
| Lakeside Learning Co. [TEST] | 3 | 5 | 1 | Ronnie Tester |
| Match Made in Heaven [TEST] | 4 | 5 | 1 | Carolina figueroa, Alejandro Gil |

1. **Booths page:** all three show their booth matched to "Booth 2", "Booth 3" and "Booth 4". Alejandro Gil is listed under Match Made in Heaven, not as his own company.
2. **Warnings:** with Booth 2 still at 1 per slot in Cvent, 21 Montopolis shows the meetings-at-once warning. Real NALES sponsors with no booth yet show "No booth".
3. **Scheduler:** file a few requests for the test sponsors and run the scheduler. Every meeting for each test sponsor is at its own booth. None has more than 5 meetings.
4. **Two at once:** set Booth 2 to 2 per slot in Cvent and run again. 21 Montopolis gets two meetings at the same time in some slots.
5. **Push:** push 21 Montopolis. In Cvent, each pair of same-time appointments has a different host.
6. **Editor:** open Edit on a Lakeside meeting. Booth 3 slots come first, and no Booth 2 or Booth 4 slots are offered.
7. **Manual mapping:** on the booths page, map Lakeside's booth number 3 to "Booth 5" and reload. The row shows "Booth 5" as a manual mapping. Run the scheduler, and Lakeside's meetings are at Booth 5. Pick "Use automatic match" and the row shows "Booth 3" again.

## Rollout

1. Make sure the portal's Salesforce integration user can read `Meetings__c` and the three new fields. Otherwise the sponsor query fails with "No such column".
2. Apply the `booth_locations` migration to production by hand.
3. Fill in `Booth_No__c` for every NALES sponsor with meetings, and give each a different booth. Check `Meetings__c`, and fill in the bonus, maximum and diaries fields. A sponsor with all three count fields blank falls back to 8 or 5. Enter 0 in `Meetings__c` for an exhibitor with no meetings, so it doesn't get 5.
4. In Cvent, set each booth's "Max. appointments allowed at same time" to match the sponsor's Diaries.
5. Check the database for requests and meetings stored under the old company ids that decision 1 removes. At NALES these are the Contact accounts of the 7 reps above. Move each one to its Opportunity's account id or delete it before deploy. A person runs this, with read-only checks first.
6. Deploy.
7. Unpush the sponsor meetings already in Cvent at the wrong booth (Booth 1 and Booth 13), re-run the scheduler, then push.

## Changes after review

Decided by Peter on 2026-11-04, after review and verification.

- **Existing meetings count toward the maximum.** Before a run books anything, a company's count starts from its meetings already pushed and its other appointments in Cvent. A company with a maximum of 5 and 5 pushed meetings gets no new ones. The run window text that says pushed meetings count against caps becomes true.
- **New meetings only get reps who are free.** Push gives a meeting only reps who are not already hosting another appointment at that time in Cvent. Existing appointments are never changed to free up a rep. The scheduler only books a company's second or later meeting at a start time when at least one rep who can host is free then.
- **A company with no reps who can host still gets one meeting at a time.** Diaries of 0 also counts as 1. The meetings are scheduled, and push reports `host_not_in_cvent` for them.
- **A slot's room subtracts appointments already in Cvent.** Cvent's `availableAppointments` is the booth's "Max. appointments allowed at same time" setting, not the room left, and Cvent lists full slots. Checked live on 2026-11-04.
- **The server refuses a meeting at another company's booth.** Saving one from the Edit or Create Meeting window returns an error, even if the window is bypassed.
- **An Opportunity with no account groups its reps by the Opportunity id.** None existed in any active event on 2026-11-04.
- **The run report gives `already_scheduled` ahead of booth problems.**
