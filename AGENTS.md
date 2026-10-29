<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Delegate meeting portal

A Next.js 16 app that schedules sponsor and delegate meetings for events and pushes them to Cvent.
This file holds the rules for anyone working in this repo, whether a person or an AI tool.
Most AI coding tools read `AGENTS.md` on their own. `CLAUDE.md` only points here.

## Building features

Features are built from an approved spec through the [agent pipeline](docs/agent-pipeline.md).
Specs live in `docs/specs/`. Start a new one from [the template](docs/specs/_template.md).

## Checks

CI runs these on every pull request. Run them before you call work done.

```
npm run lint
npm run typecheck
npm test
DATABASE_URL=postgres://ci:ci@localhost:5432/ci npm run build
```

Lint warnings that already exist are fine. New errors are not.

## Safety

- Automated agents never use production credentials. They work in mock mode (`USE_MOCK=true`) with the fixtures in `data/mock/`, extended as needed.
- Never copy or create `.env.local` or any other env file with real credentials.
- Never run `npm run db:migrate`. `npm run db:generate` is fine. A person applies migrations to each database by hand before deploy.
- Agents never call real Cvent, Salesforce, Twilio or Neon. Read-only checks against real data are run by a person, or under their direct supervision.
- Agents never push, open pull requests, merge or force anything. People do.

## Code conventions

- Match the surrounding code's naming, structure and comment density.
- Comments are simple, full sentences, one idea per line. No em-dashes and no semicolons.
- Every new function gets JSDoc, including helper functions in test files.
- When you move code between files, keep its JSDoc and inline comments word for word.
- Tests use vitest, in `*.test.ts` files next to the code.
- Prefer small pure functions that can be tested without the database or Cvent.
- Server actions return expected errors instead of throwing them. Production hides thrown messages.

## Commits

- Commit in small steps a reviewer can follow, for example data, then logic, then UI, then tests.
- Write a short imperative subject, then a plain-English body saying what changed and why.
- No AI co-author trailers.

## Known Cvent behavior

These were learned the hard way. When you learn something new, add it here and add a test so it can't regress.

- Cvent never frees an appointment code, even after the appointment is cancelled.
- A cancelled registrant fails with `ATTENDEE_NOT_FOUND`.
- Sponsor reps also appear in the delegate list unless they are removed.
- An appointment's type can't be changed after it is created.
- Moving an appointment to the same start time collides unless it is updated in place.
- Looking up one appointment by id returns 404, even when it exists. Use the event's appointment list instead.
- The appointment list spans several pages.
- Creating an appointment without a `location` fails with `TIMESLOT_NOT_FOUND`, even for a real slot.
