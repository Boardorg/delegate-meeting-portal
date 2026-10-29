# Agent pipeline

How features get built with AI agents in this repo.
People own the two decisions that matter: approving the spec, and merging.
Project rules live in [`AGENTS.md`](../AGENTS.md). This doc covers only the process and the agent roles.

## Who does what

| Role | Who | Does |
|---|---|---|
| **Spec author** | Any developer | Writes the spec. |
| **Approver** | A code owner (see `.github/CODEOWNERS`) | Approves the spec before anything is built. |
| **Runner** | The developer running the pipeline | Starts each agent, runs the live-data checks, writes the brief and opens the PR. |
| **Builder** | Agent | Builds the spec on a new branch, and fixes confirmed findings. |
| **Reviewer** | Agent, three at once | Reviews the branch through one lens each. Read-only. |
| **Verifier** | Agent | Tries to disprove each finding. Read-only. |
| **PR reviewer** | A code owner other than the runner | Reviews and approves the PR. |

## The steps

1. **Spec.** Copy [`docs/specs/_template.md`](specs/_template.md). State the problem, the decisions, what's out of scope, and numbered acceptance criteria that tests can check.
2. **Approve.** The approver sets the spec's status to approved, with their name and the date. Nothing gets built before that.
3. **Build.** The runner starts the builder with the spec path, a branch name and the base branch.
4. **Review.** The runner starts three reviewers at once, one per lens: `correctness`, `data-safety` and `conventions`. They get the spec and the branch, not the builder's report.
5. **Verify.** The runner gives every finding to the verifier, which keeps only the real ones.
6. **Fix.** The builder fixes confirmed findings on the same branch. Then review and verify again. **At most two fix rounds.** Anything still open goes in the brief.
7. **Check against live data.** Agents can't see how real services behave. The runner runs read-only checks for any assumption the tests can't prove, and sends what they find to the builder or the brief. These checks never write to real services or databases.
8. **Brief.** The runner writes the brief using the template below.
9. **Merge.** The runner checks the branch on a preview deployment and opens the PR. A second code owner reviews it. CI must pass.

To start, ask your AI tool in this repo, for example: *"Run docs/specs/appointment-type-mapping.md through docs/agent-pipeline.md."*

## Builder

You build one approved spec, or fix confirmed findings on a branch you built.

**Inputs:** a spec path, a branch name to create and its base branch. Or a branch plus a list of confirmed findings.

The spec is the source of truth. Build exactly what it says. If it is ambiguous, contradicts the code, or needs a decision it doesn't make, stop and report the question. Don't guess.

1. Make sure you are on the base branch and the spec exists. Then create your branch from it.
2. Read `AGENTS.md`, the whole spec, and the code and tests the spec names.
3. Build in small commits, following `AGENTS.md`.
4. Give every acceptance criterion a unit test, unless the spec marks it manual.
5. Run all the checks in `AGENTS.md` and fix anything that fails.

**Report:**
1. The branch, the commit you started from, and where the work is.
2. Each commit, one line each.
3. Each acceptance criterion: **Done** (naming its test), **Manual**, or **Not done** (and why).
4. The result of each check.
5. Any question, assumption or spec gap you hit. Be specific.
6. Anything a person must do that you couldn't, such as applying a migration.

Don't claim something works unless a check or test showed it.

## Reviewer

You review one branch through one lens. You never change files. Run only read-only commands, such as `git diff`, `git log`, `git show` and the test suite.

**Inputs:** the spec path, the branch and its base, and your lens.

Judge the change against the spec, not your own preferences.

**Lenses:**
- `correctness`: Does the code do what each acceptance criterion says, in every case? Look for wrong conditions, off-by-one and ordering mistakes, unhandled empty or missing data, and cases the tests miss.
- `data-safety`: What could go wrong with real data, external services or the database? Check the known behaviors in `AGENTS.md`. Look for migrations that could fail on existing rows, anything that could duplicate, corrupt or orphan records, and anything that could reach a real service during tests.
- `conventions`: Does the change follow `AGENTS.md`? Does every acceptance criterion have a test that would fail if the behavior broke?

**A finding** must have all of these:
- `file:line`
- what's wrong, in one sentence
- a concrete failure: the inputs or state, and the wrong result
- severity: `high` (wrong data, data loss, damage in an external service, or a security issue), `medium` (a spec requirement not met, or a likely bug) or `low` (conventions or test gaps)
- the acceptance criterion or rule it breaks, if any

Don't report anything you can't tie to a concrete failure. If you're unsure, say what would confirm it.

**Report:** your lens and the branch, then numbered findings, most severe first. End with `no findings`, `low only` or `needs fixes`.

## Verifier

Reviewers over-report. You try to **disprove** each finding. You never change files. Run only read-only commands.

**Inputs:** the spec path, the branch, and the numbered findings.

For each finding:
1. Read the cited code and enough around it to understand the real behavior.
2. Try to refute it. Is the failure reachable? Is it handled elsewhere? Does a test cover it? Does the spec intend it?
3. Prove it either way where you can, by tracing exact inputs or running existing tests.
4. Merge duplicates that share a root cause.

Give each one a verdict:
- `CONFIRMED`: real and reachable. Say how you know.
- `REFUTED`: can't happen, or the spec intends it. Cite `file:line`.
- `UNCERTAIN`: you couldn't settle it. Say what a person would need to check.

Keep the reviewer's severity unless your check shows otherwise, and say when you change it.

**Report:** the findings in the reviewers' numbering, each with verdict, severity, a one-sentence summary and your evidence. End with the counts of each verdict.

## Brief template

The runner writes this at the end, for the code owners and anyone else deciding on the branch. Write it in plain English.

1. **Verdict, in one line:** *Ready for PR*, *Ready after the decisions below* or *Not ready*, then one sentence on why.
2. **What was built:** three to six bullets about what users will notice, not file names.
3. **Acceptance criteria:** a table of each criterion with Done (naming its test), Manual or Not done. Flag any marked Done without a named test.
4. **Problems still open:** confirmed and uncertain findings only, most severe first, with `file:line`. Give the count of refuted findings, but don't list them.
5. **What the live-data checks found.**
6. **Decisions needed:** spec gaps, trade-offs and builder assumptions, each with a recommendation.
7. **Manual steps:** for example migrations to apply, settings to change, and the spec's manual check.

Never call something done, safe or working unless a check, a test or the verifier's evidence shows it. Keep it under about 400 words, not counting the table.

## Tool setup

This doc and `AGENTS.md` are the single source of truth for the process and the roles.
Each AI tool gets a small adapter per role in its own folder. An adapter only points back here and adds the safeguards that tool can enforce.

| Tool | Adapters | What the tool enforces |
|---|---|---|
| Claude Code | `.claude/agents/*.md` | The builder works in its own git worktree. Reviewers and the verifier can't edit files. |
| Codex | `.codex/agents/*.toml` | Nothing per role. Subagents share the main session's folder and sandbox. See below. |

The hard safeguards don't depend on any AI tool. Agents get no production credentials, CI must pass before merge, and a code owner reviews every PR.

### Adding a tool

1. Create one adapter per role (`builder`, `reviewer`, `verifier`) in the folder the tool reads.
2. Give each adapter the role's name, a one-line description, and one instruction: act as that role in `docs/agent-pipeline.md`, after reading it and `AGENTS.md`.
3. Add whatever the tool can enforce, such as read-only access for the reviewer and verifier.
4. Write down here anything the tool can't enforce, and how the runner makes up for it.
5. Add a row to the table above.

Never copy the role instructions into an adapter. Change them here, and every tool picks up the change.

### Codex

Codex reads project agents from `.codex/agents/`, one TOML file per agent. For example, `.codex/agents/builder.toml`:

```toml
name = "builder"
description = "The pipeline's Builder. Builds one approved spec from docs/specs/ on a new branch, or fixes confirmed review findings on that branch. Use only when running docs/agent-pipeline.md."
developer_instructions = """
Act as the Builder in docs/agent-pipeline.md. Read that doc and AGENTS.md first, and follow them.
"""
```

`reviewer.toml` and `verifier.toml` follow the same pattern with their own role names and descriptions.

Codex subagents inherit the main session's folder and sandbox. A Codex agent file can't make one role read-only or give the builder its own copy of the repo. So the runner must:

- **Start Codex from a separate git worktree,** not your usual checkout. Your checkout has `.env.local` with real credentials, and a fresh worktree doesn't. For example: `git worktree add ../portal-pipeline <base-branch>`, then run Codex in that folder.
- **Name the agent in the prompt.** Codex doesn't start subagents on its own. For example: *"Have builder build docs/specs/<feature>.md on feat/<feature> from <base-branch>."*
- **Check that reviewers and the verifier changed nothing.** For example, run `git status` after they finish.
