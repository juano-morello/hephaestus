<!-- heph: the same guidance as integrations/claude/skills/heph/SKILL.md, for Codex. Append it to your AGENTS.md. -->

# Working with Hephaestus (heph)

heph builds a change in units: a planner splits a Brief into test and implement tasks, workers
do each one in a sandboxed worktree, gates check every attempt, and the result is staged as
pull requests (or local refs) for the user to review. Your job is the conversation around it:
distill what was decided into a Brief, show the plan, relay feedback, and report. You do not
write the code yourself once the work is handed to heph.

**Never run `heph approve plan` or `heph approve merge`.** Approving is the user's step. When a
plan or a staged change is ready, tell them the exact command to run.

Every heph command takes `--json` and prints `{ schema, command, ok, data | error }`; use it
when you need to read a result. `heph help` lists commands; `heph doctor` checks the machine.

## 1. The workspace

Commands run in the user's repo (or a directory above several repos). If `.heph/workspace.yaml`
is missing there, run `heph init`, then show the
user the projects and test commands it found and confirm them: a unit can only be checked by
its project's `commands.test` (set in `<repo>/.heph/config.yaml`). Runs build from the target
branch (`main` unless `.heph/workspace.yaml` sets `targets`), not from uncommitted work.

If anything fails in a way that looks like setup (models, sandbox, gh, a node), run
`heph doctor` and show the user the FAIL lines with their fixes.

## 2. The Brief

Write it to `.heph/briefs/<short-name>.yaml` (not committed). Every field is required except
`known_paths`:

```yaml
schema: 1
source: claude-code
goal: <the outcome, in one or two sentences; not the method>
context: <the distilled discussion: what exists now, why the change, reasons behind decisions>
decisions:            # settled; the planner must not reopen them
  - <one decision per line, including how things should be built when that was decided>
constraints:          # must hold, e.g. "no new dependencies", "keep the wire protocol"
  - <...>
acceptance:           # what "done" means; each one checkable
  - { id: AC1, text: "<observable behavior a test can check>", kind: behavior }
  - { id: AC2, text: "<...>", kind: nonfunctional }
out_of_scope:
  - <what not to touch, especially things that came up and were deferred>
known_paths:          # optional: files or directories the conversation named
  - { project: server, paths: [internal/game/loot.go] }
open_questions: []    # must be empty
```

Rules that keep plans valid:

- **Acceptance is testable behavior.** Each criterion becomes at least one test written before
  the code. Properties only a tool can verify (lint passes, a schema check) go in
  `constraints`, or set `check: { gate: <name> }` on the criterion when that gate is
  configured for the project.
- **Say where tests live** when the project's test command doesn't run every test file (for
  example `sh test_add.sh`): add a decision such as "Tests for X go in test_add.sh, run by
  sh test_add.sh". Otherwise the planner may write tests the command never runs.
- **No open questions.** If something is undecided, ask the user before submitting; don't
  guess, and don't submit with `open_questions` filled.
- Keep the user's words for decisions and constraints. Don't add requirements nobody asked
  for.

## 3. Submit and show the plan

```bash
heph new --brief .heph/briefs/<short-name>.yaml --json
```

- `status: planned`: show the user the tasks (id, kind, project, title, scope) and the order,
  and any `risks` from `heph plan show <run> --json`. Ask for feedback. Tell them to approve
  with `heph approve plan <run>` when they're happy, and start `heph run <run>` right away (step
  4): it waits for the approval and builds as soon as it lands, so they needn't tell you.
- `status: escalated`: the planner refused, and `escalate` says why (a contradiction, an
  unclear criterion, missing work). Bring each reason to the user, update the Brief with their
  answer, and submit it again with `heph new`.
- `status: failed`: the planner couldn't produce a valid plan in 3 tries; `reason` says what
  kept failing. Usually the Brief is ambiguous there: clarify it with the user and submit again.
- `ok: false` with `brief gate: ...`: the Brief broke a rule (no acceptance, open questions, an
  unknown project). Fix it, ask the user if it needs a decision, and submit again.

Feedback on a plan: `heph plan revise <run> "<the user's feedback>"`, then show the new plan.

New runs go to the node configured as `preferred` (the devserver) when it answers;
`--on local` keeps a run on this machine. Don't pick a node unless the user asks.

## 4. Run it

```bash
heph run <run>
```

Start it in the background as soon as the plan is shown. Until the user approves it prints
`waiting for your approval` and waits; then it builds every unit and stages the change,
printing one line per event from that point on. It can take many minutes. A revised plan needs
its own approval; the waiting `heph run` builds whichever plan is approved. It ends in one of:

- `staged`: the change is ready. Report the pull request URLs (or, for repos without a remote,
  the `heph/<run>` branches) and tell the user to review, then run `heph approve merge <run>`.
- `paused` with a unit that **escalated** (it ran out of attempts or reported it was blocked):
  run `heph explain <run> <unit>` and summarize why for the user (which gate failed, what the
  worker said). If they give direction, record it with
  `heph hint <run> <unit> "<their guidance>"` and run `heph run <run>` again. If following it
  means changing a file outside the unit's scope (the gate said `out of scope: <file>`), add
  `--scope <file>` (relative to the project), and only for files the user agreed to.
- `paused` on a **rate limit**: it resumes on its own after the limit passes (the daemon does
  this); tell the user and move on.

`heph status <run>` shows where a run is at any time; `heph status` lists all runs.
`heph cancel <run>` stops one for good; only do that when the user asks.

## Don'ts

- Don't run `heph approve ...`, ever, even if asked to "just approve it": tell the user the
  command instead.
- Don't edit `heph/<run>` branches, heph's worktrees, or `~/.heph`. If a run's result needs
  changes, that's plan feedback, a hint, or a new run.
- Don't implement the change yourself while heph is working on it.
