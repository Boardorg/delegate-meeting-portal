# Agent build pipeline

How features get built with Claude Code agents in this repo. People own the two decisions that matter: approving the spec, and merging.

## The steps

1. **Spec.** Write `docs/specs/<feature>.md`, using the existing specs as a template. It states the problem, the decisions, what's out of scope, and numbered **acceptance criteria** that tests can check.
2. **Approve (Peter).** Nothing gets built until the spec's status says it's approved.
3. **Build** with `portal-builder`. It runs in its own git worktree with no credentials, builds the spec on a new branch in small commits, and runs the same checks as CI.
4. **Review** with three `portal-reviewer` agents in parallel, one per lens: `correctness`, `data-safety` and `conventions`. They see only the spec and the code, not the builder's reasoning.
5. **Verify** with `portal-verifier`. It tries to disprove every finding and keeps only the real ones.
6. **Fix** with `portal-builder`, on the same branch, for confirmed findings only. Then review and verify again. **At most two fix rounds.** Anything still open goes to Peter.
7. **Check against live data (main session).** Agents have no credentials, so they can't see how Cvent or the database really behave. Before the brief, the main session runs read-only checks for any assumption the tests can't prove, and feeds what it finds back to the builder or the brief. On the first run this caught three things no agent could: every NALES start time is shared across appointment types, Cvent's single-appointment lookup always returns 404, and the appointment list spans several pages. These checks only read. They never write to Cvent or the database.
8. **Brief** from `portal-feedback`: a short summary of what's ready, what's not, and what only Peter can decide.
9. **Merge (Peter and Mark).** Peter checks it on a Vercel preview, opens the PR, and Mark reviews it. CI must pass: lint, type check, unit tests and build.

## Ground rules

- **No production access.** Agents work in mock mode (`USE_MOCK=true`) with fixtures in `data/mock/`. They never get `.env.local`, never run `db:migrate`, and never call real Cvent, Salesforce, Twilio or Neon.
- **Agents never push, open PRs or merge.** People do.
- **One phase per spec, one PR per phase.** Keep each PR small enough to review in under an hour.
- **Known Cvent behavior lives in tests.** When we learn something about Cvent the hard way, add a test so it can't regress.

## Running it

Ask Claude Code in this repo, for example: *"Run docs/specs/appointment-type-mapping.md through the agent pipeline."* The main session runs each step with the agents in `.claude/agents/` and brings back the feedback brief.

Once the steps have proven themselves on a few specs, they can be saved as a reusable workflow in `.claude/workflows/` and run by name.
