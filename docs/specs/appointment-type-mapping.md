# Spec: Appointment-type mapping

Status: **Draft, awaiting approval from Peter**
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

1. **Each event maps its Cvent appointment types to a meeting kind.** The kinds are `sponsor_delegate`, `delegate_delegate`, `delegate_group` and `ignore`. Unmapped types behave as `ignore`.
2. **Sponsor meetings only ever use `sponsor_delegate` slots**, in the scheduler, in the admin Edit and Create Meeting windows, and on push.
3. **Day 2 spillover for diamond sponsors.** The scheduler fills sponsor meetings into Day 1 `sponsor_delegate` slots first. A pair whose sponsor company is **diamond** may use a Day 2 `sponsor_delegate` slot when no Day 1 slot works. Standard sponsors stay on Day 1. (Event team: "S2D usually take place on day 1 and we add additional on day 2 for those with larger meeting packages.")
4. **Sponsor meeting limits count across both days.** Once a diamond sponsor can have Day 2 sponsor meetings, the per-pass sponsor and delegate caps for sponsor meetings must count that party's sponsor meetings on **every** day, not just the pass's day. Otherwise a diamond sponsor could exceed their package.
5. **No mapping means no scheduling.** If an event has no type mapped to `sponsor_delegate`, the scheduler refuses to run, with a message telling the admin to set it in Event settings. It never guesses.
6. **Push refuses a mis-typed slot.** As a safety net, push skips any meeting whose slot is not `sponsor_delegate`, with a new failure reason `wrong_appointment_type`. This catches rows created before this fix.
7. **Delegate-to-delegate passes (6 and 7) use only `delegate_delegate` slots.** Their day rule is unchanged for now. Delegate scheduling is out of scope (see below).
8. **Admins can still pick any `sponsor_delegate` slot on either day** in the Edit and Create Meeting windows, whatever the sponsor's tier. Admins are the override.

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

- Sponsor passes (1 to 5) only consider `sponsor_delegate` slots, Day 1 first, then Day 2 for diamond sponsors (decision 3).
- Sponsor-meeting caps count across days (decision 4).
- Passes 6 and 7 only consider `delegate_delegate` slots (decision 7).
- `runSchedulerForEvent` refuses to run without a `sponsor_delegate` mapping (decision 5).

### Admin meeting editor (`app/admin/meetings/[sponsorId]/actions.ts`)

- Slot options for Edit and Create Meeting list only `sponsor_delegate` slots, on both days (decision 8).

### Push (`lib/cvent/push.ts`, `lib/cvent/syncReport.ts`, `SyncReportPanel.tsx`)

- Skip meetings whose slot kind isn't `sponsor_delegate`, with reason `wrong_appointment_type`, a label and a hint (decision 6).

## Out of scope

- Delegate logins, delegate requests, round tables and request windows.
- The Day 2 policy for delegate-to-delegate meetings.
- Choosing which profile fields drive matching.
- Cleaning up the mis-typed test appointments in Cvent. That is an operations step after deploy (see Rollout).

## Acceptance criteria

Each one must be covered by a unit test unless marked otherwise.

1. A timeslot whose appointment type is mapped to `sponsor_delegate` gets that kind. An unmapped type gets `ignore`.
2. The scheduler never books a sponsor meeting into a slot whose kind is not `sponsor_delegate`, even when such a slot is free and earlier in the day.
3. A standard sponsor's meetings are only ever on Day 1.
4. A diamond sponsor gets a Day 2 `sponsor_delegate` slot only when no Day 1 slot works for that pair.
5. A diamond sponsor never exceeds 8 sponsor meetings in total across both days. A standard sponsor never exceeds 5.
6. A delegate's sponsor-meeting cap counts their sponsor meetings on both days.
7. Passes 6 and 7 only book `delegate_delegate` slots.
8. `runSchedulerForEvent` throws a clear error when the event has no `sponsor_delegate` mapping, and writes nothing.
9. Admin slot options include `sponsor_delegate` slots from both days and nothing else.
10. Push skips a meeting on a non-`sponsor_delegate` slot with reason `wrong_appointment_type`, and does not call Cvent for it.
11. Saving Event settings rejects an unknown kind value.
12. All existing tests still pass. `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass, as in CI.
13. *(Manual, by Peter)* On a Vercel preview with NALES mapped, a scheduler run puts every sponsor meeting in a "Sponsor to Delegate Meetings" slot, and pushed appointments show that type in Cvent.

## Constraints for whoever builds this

- Follow `AGENTS.md`: read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code.
- Never use production credentials. Work in mock mode (`USE_MOCK=true`) with fixtures under `data/mock/cvent`, extended as needed for multiple appointment types. Never run `db:migrate` against a real database.
- Comments: simple full sentences, one idea per line, no em-dashes or semicolons. JSDoc on every new function, including test helpers.
- Keep existing comments when moving code.
- Commit in small, reviewable steps. No `Co-Authored-By` trailer.

## Rollout

1. Apply the migration to production by hand.
2. Deploy.
3. In Event settings for NALES, map "Sponsor to Delegate Meetings" to `sponsor_delegate`, "Delegate to Delegate Meetings" to `delegate_delegate`, "Delegate Group Meetings" to `delegate_group`, and "Themed Lunches (Round Tables)" to `ignore`.
4. Clean up the mis-typed test appointments. Cvent can't change an appointment's type, so use **Unpush All Synced**, re-run the scheduler, then **Push All to Cvent**.
5. Check the result in Cvent (acceptance criterion 13).
