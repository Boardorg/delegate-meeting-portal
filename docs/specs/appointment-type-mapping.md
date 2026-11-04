# Spec: Appointment-type mapping

Status: **Approved by Peter, 2026-10-22**
Owner: Peter Wiley
Branch: `feat/appointment-type-mapping`
Process: [agent pipeline](../agent-pipeline.md)

## Problem

The scheduler and the admin meeting editor choose Cvent slots by **day**, never by Cvent **appointment type**.
The day is derived from date order in `toTimeslots()` (`lib/cvent/mapper.ts`). The earliest date is "Day 1", used for sponsor meetings. The next date is "Day 2", used for delegate-to-delegate meetings.
Push sends whatever appointment type the chosen slot has.

NALES has four appointment types, and each type with slots has them on both days:

| Appointment type | Wed Jan 20 | Thu Jan 21 |
|---|---|---|
| Sponsor to Delegate Meetings | 14 | 4 |
| Delegate Group Meetings | 16 | 6 |
| Delegate to Delegate Meetings | 4 | 6 |
| Themed Lunches (Round Tables) | 0 | 0 |

As a result, 17 of the 19 sponsor meetings the portal pushed to NALES were filed in Cvent under the wrong type (7 as Delegate Group, 10 as Delegate to Delegate). Checked 2026-10-20.

The first event goes live **for sponsors only**. This spec fixes sponsor meetings. It leaves delegate meeting kinds stored but unused, so later work can build on them.

## Decisions

1. **Each event maps its Cvent appointment types to a meeting kind.** The kinds are `sponsor_delegate`, `delegate_delegate`, `delegate_group` and `ignore`. Unmapped types behave as `ignore`. Event settings lists every appointment type Cvent returns, with all four kinds available. Only the `sponsor_delegate` mapping is required for now. Nothing uses `delegate_group` yet, since group meetings are delegates plus one staff member.
2. **The meeting kind comes from who is meeting, never from an admin.** A sponsor company with a delegate is `sponsor_delegate`. Two delegates is `delegate_delegate`. Admins never choose a type.
3. **The scheduler only puts sponsor meetings in `sponsor_delegate` slots.** Admins can override this by hand (decision 9).
4. **Day 2 spillover for diamond sponsors.** The scheduler fills sponsor meetings into Day 1 `sponsor_delegate` slots first. A pair whose sponsor company is **diamond** may use a Day 2 `sponsor_delegate` slot when no Day 1 slot works. Standard sponsors stay on Day 1. (Event team: "S2D usually take place on day 1 and we add additional on day 2 for those with larger meeting packages.")
5. **Sponsor meeting limits count across both days.** Once a diamond sponsor can have Day 2 sponsor meetings, the per-pass sponsor and delegate caps for sponsor meetings must count that party's sponsor meetings on **every** day, not just the pass's day. Otherwise a diamond sponsor could exceed their package.
6. **Missing mappings are handled without losing work.** A scheduler run replaces every meeting that hasn't been pushed yet.
   - If no type is mapped to `sponsor_delegate`, the run would delete those meetings and create none. So the scheduler stops before changing anything and shows a message telling the admin to set the mapping in Event settings.
   - If `sponsor_delegate` is mapped but other types are not, the run goes ahead. It ignores the unmapped types' slots and lists them as a warning in the run report.
7. **Push respects the slot and flags overrides.** Push sends every meeting with its slot's appointment type, as it does today. When a sponsor meeting is in a slot that isn't `sponsor_delegate`, the push still goes ahead and the sync report adds a warning such as "Pushed as Delegate Group Meetings". Nothing is skipped for its type. The scheduler never creates these once mapped, so the warning only appears for admin overrides and for meetings created before this fix.
8. **Delegate-to-delegate passes (6 and 7) use only `delegate_delegate` slots.** Their day rule is unchanged for now. Delegate scheduling is out of scope (see below).
9. **Admins can pick any slot.** The Edit and Create Meeting windows list every slot on both days, grouped by Cvent appointment type, with `sponsor_delegate` slots first. Choosing a slot of another type shows a warning in the window, for example "This meeting will appear in Cvent as a Delegate Group Meeting." Tier rules don't apply to admin choices.

## Scope

### Data

- New nullable `jsonb` column `appointment_type_kinds` on `event_settings`: an object mapping Cvent appointment type id to kind, for example `{ "fc560dc7-…": "sponsor_delegate" }`.
- Generate the migration with `npm run db:generate`. It must be applied to production by hand before deploy, as with `theme_color`. Note this in the PR.

### Cvent client

- New `getAppointmentTypes(eventCode)` in `lib/cvent/client.ts`, wrapping the SDK's `appointments.listAppointmentTypes`. Returns `{ id, name }[]`. Mock mode reads a new fixture.

### Event settings (admin)

- On Event settings, a section listing every appointment type for the event (from `getAppointmentTypes`), each with a kind dropdown. Saving validates that each kind is one of the four allowed values.
- If the event has no Cvent Appointment Event ID, or Cvent can't be reached, the section explains why it can't load and still lets the rest of the form save.

### Mapping into timeslots

- `Timeslot` gains `kind: MeetingKind` (unmapped types become `ignore`). `loadEventScheduleData` reads the event's mapping and sets it.
- `day` stays as is. It is still used for display and for the Day 1 / Day 2 rules above.

### Scheduler (`lib/scheduling/engine.ts`, `app/admin/meetings/actions.ts`)

- Sponsor passes (1 to 5) only consider `sponsor_delegate` slots, Day 1 first, then Day 2 for diamond sponsors (decision 4).
- Sponsor-meeting caps count across days (decision 5).
- Passes 6 and 7 only consider `delegate_delegate` slots (decision 8).
- `runSchedulerForEvent` stops without a `sponsor_delegate` mapping, and reports unmapped types as a warning otherwise (decision 6).

### Admin meeting editor (`app/admin/meetings/[sponsorId]/actions.ts`)

- Slot options for Edit and Create Meeting list every slot on both days, grouped by appointment type with `sponsor_delegate` first. Each option carries its type name and kind. Choosing a non-`sponsor_delegate` slot shows a warning before saving (decision 9).

### Push (`lib/cvent/push.ts`, `lib/cvent/syncReport.ts`, `SyncReportPanel.tsx`)

- When a sponsor meeting's slot kind isn't `sponsor_delegate`, push it as normal and add a warning naming the appointment type it was pushed as (decision 7).

## Out of scope

- Delegate logins, delegate requests, round tables and request windows.
- The Day 2 policy for delegate-to-delegate meetings.
- Choosing which profile fields drive matching.
- Cleaning up the mis-typed test appointments in Cvent. That is an operations step after deploy (see Rollout).

## Acceptance criteria

Each one must be covered by a unit test unless marked otherwise.

**Mapping**
1. A timeslot whose appointment type is mapped to `sponsor_delegate` gets that kind. An unmapped type gets `ignore`.
2. Event settings offers every appointment type Cvent returns, each with all four kinds. Saving with only `sponsor_delegate` mapped is allowed.
3. Saving Event settings rejects an unknown kind value.

**Scheduler**

4. The scheduler never books a sponsor meeting into a slot whose kind is not `sponsor_delegate`, even when such a slot is free and earlier in the day.
5. A standard sponsor's meetings are only ever on Day 1.
6. A diamond sponsor gets a Day 2 `sponsor_delegate` slot only when no Day 1 slot works for that pair.
7. A diamond sponsor never exceeds 8 sponsor meetings in total across both days. A standard sponsor never exceeds 5.
8. A delegate's sponsor-meeting cap counts their sponsor meetings on both days.
9. Passes 6 and 7 only book `delegate_delegate` slots.
10. With no `sponsor_delegate` mapping, `runSchedulerForEvent` stops with a clear message and leaves every existing meeting untouched.
11. With `sponsor_delegate` mapped and other types unmapped, the run succeeds and its report warns about each unmapped type by name.

**Admin editor**

12. Edit and Create Meeting slot options include every slot from both days, grouped by appointment type, with `sponsor_delegate` slots first. Each option says which appointment type it is.
13. Choosing a slot that isn't `sponsor_delegate` in Edit or Create Meeting shows the type warning. Choosing a `sponsor_delegate` slot shows no warning.

**Push**

14. Push sends a sponsor meeting on a non-`sponsor_delegate` slot with that slot's appointment type, and its result carries a warning naming the type. A meeting on a `sponsor_delegate` slot gets no such warning.

**Overall**

15. All existing tests still pass. `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass, as in CI.
16. *(Manual, by Peter)* The preview checks in "Manual check" below all pass.

## Manual check (Peter, on a Vercel preview)

Use a preview deployment pointed at the staging database, with NALES mapped in Event settings. Previews still talk to the real NALES Cvent event, so step 6 creates real test appointments, the same as earlier testing.

1. **Event settings:** NALES shows all four Cvent appointment types. Map "Sponsor to Delegate Meetings" only, save, and reload. The mapping is kept.
2. **Safety stop:** on a copy of the event with no mapping, click "Run Scheduling Engine". It stops with the message, and the meeting list is unchanged.
3. **Scheduler:** with NALES mapped, run the scheduler. Open a few sponsor companies. Every meeting time is a "Sponsor to Delegate" slot. Standard sponsors have Wednesday meetings only. Any Thursday meetings belong to diamond sponsors.
4. **Limits:** no standard company shows more than 5 scheduled meetings, and no diamond company more than 8.
5. **Admin editor:** open Edit on a meeting. The Time Slot list shows every slot grouped by type, sponsor slots first. Pick a Delegate Group slot and check the warning appears. Cancel without saving.
6. **Push:** push all. In Cvent, every new appointment's type is "Sponsor to Delegate Meetings".

## Constraints for whoever builds this

- Follow `AGENTS.md`: read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code.
- Never use production credentials. Work in mock mode (`USE_MOCK=true`) with fixtures under `data/mock/cvent`, extended as needed for multiple appointment types. Never run `db:migrate` against a real database.
- Comments: simple full sentences, one idea per line, no em-dashes or semicolons. JSDoc on every new function, including test helpers.
- Keep existing comments when moving code.
- Commit in small, reviewable steps. No `Co-Authored-By` trailer.

## Rollout

1. Apply the migration to production by hand.
2. Deploy.
3. In Event settings for NALES, map "Sponsor to Delegate Meetings" to `sponsor_delegate`. Mapping the other types is optional for now.
4. Clean up the mis-typed test appointments. Cvent can't change an appointment's type, so use **Unpush All Synced**, then re-run the scheduler, then **Push All to Cvent**. Re-run the scheduler before pushing. Otherwise the old meetings still on wrong-type slots get pushed with those types again (decision 7).
5. Check the result in Cvent (manual check step 6).

## Changes after review

- A scheduler run also stops before changing anything when the attendees it would use (leaving out cancelled registrations) include no sponsors or no delegates, since a failed Cvent attendee lookup returns no one.
- When a re-push can't create its replacement because the host is busy, push only edits the old appointment in place (after checking its type) when the old appointment starts at the same time as the new slot. A move to another time reports "Host slot full" and changes nothing.
