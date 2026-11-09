---
name: heph
description: Hand work to Hephaestus (the heph CLI) instead of coding it in this session - turn the conversation into a Brief, submit it with heph new, show and revise the plan, run the build, and report results. Use when the user asks for heph or Hephaestus to build, fix or implement something, says "let's tackle this" / "send it to heph" about work you discussed, or asks about a heph run (its status, plan, or why a unit failed or escalated). Never approves anything.
---

# Working with Hephaestus (heph)

heph builds a change in units: a planner splits a Brief into test and implement tasks, workers
do each one in a sandboxed worktree, gates check every attempt, and the result is staged as
pull requests (or local refs) for the user to review. Your job is the conversation around it:
distill what was decided into a Brief, show the plan, relay feedback, and report. You do not
write the code yourself once the work is handed to heph.

**Never run `heph approve plan` or `heph approve merge`.** Approving is the user's step. When a
plan or a staged change is ready, tell them the exact command to run.

When the `heph_*` MCP tools are available (in Claude Code they are `mcp__heph__*`), prefer them to the `heph` CLI: `heph_new` with the Brief as an object, `heph_plan_show`, `heph_plan_revise`, and `heph_run`, which starts the build and returns at once (if it says `awaiting_plan_approval`, ask the user to run `heph approve plan <run>` themselves). In Claude Code, start `heph watch <run>` with the Monitor tool right after `heph_run` (see "Following a run"): it pushes every milestone to you while you are idle, which `heph_watch` cannot (it only answers while you are calling it, so a run that needs the user goes unnoticed once your turn ends). Use `heph_watch` with the returned `cursor` as `since` for a one-off catch-up, or where Monitor is not available (in the Claude desktop and Codex apps each `heph_watch` return redraws the run widget, so loop it there and keep your own text between returns to a minimum); when `outcome` is anything but `running`, stop and ask the user. At the start of every turn while a run is active, call `heph_status` with no run: a run marked `needs you:` is blocked on the user, so lead your reply with it and the command it names. There is no approve tool and you must never approve: the user runs `heph approve ...`. When the tools are absent, use the CLI and `heph watch` as described below.

Plans from `heph_plan_show` render as a widget in the Codex app and the Claude desktop app, and as text everywhere else; either way approval is still the user's action outside the chat (`heph approve plan <run>`), and the widget has no approve button.

Run status from `heph_status` and every `heph_watch` return render as a widget too (the run's units as a graph, or the list of runs) in the Codex app and the Claude desktop app, and as text everywhere else; it has a Refresh button only in Codex, and no cancel, hint or approve buttons.

Every heph command takes `--json` and prints `{ schema, command, ok, data | error }`; use it
when you need to read a result. `heph help` lists commands; `heph doctor` checks the machine; `heph nodes` shows which peers this node can reach.

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
  configured for the project. Define the gate as a command in the repo's `.heph/config.yaml`
  (`gates: { buf: "buf lint" }`); heph runs it on the unit that covers the criterion.
- **Every criterion names a runnable check before you submit.** It is either a test (behavior
  a test can assert) or a gate (`check: { gate: <name> }`). That includes `nonfunctional`
  criteria: "no allocations per tick" or "coverage stays above X" needs a benchmark test or a
  custom gate, not prose. If a criterion has neither, say so and ask the user how it should be
  checked, or move it to `constraints` as a note. This is the "done when" of the Brief; heph
  enforces it when the covering unit is accepted.
- **Set `projects` on a criterion that needs tests in more than one project** (for example
  `projects: [server, client]`): the plan must then have a covering test task in each.
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

`heph run <run> --dry-run` previews the planned build (models, tiers, parallel waves) without spending tokens; useful before `heph run` on a large plan.

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
- `paused` with a unit that **stalled** (`heph watch` says `T2 stalled: tests failed the same way
  on a1 and a2`): two attempts in a row failed identically, so more attempts won't help and heph
  stopped before spending them. Don't retry and don't hint on your own. Run
  `heph explain <run> <unit>`, tell the user what keeps failing and why it looks structural (a
  criterion a later task owns, a file outside the unit's scope, a wrong decision in the Brief),
  and ask: a hint (`--scope <file>` for a file they agree to), a plan revision, or a new Brief.
- `paused` on a **rate limit**: it resumes on its own after the limit passes (the daemon does
  this); tell the user and move on.

### Following a run

`heph run` prints only to its own terminal, so start the follower next to it. In Claude Code, run
`heph watch <run>` with the Monitor tool (or as a second background command) right after
`heph run`: it prints one line per milestone (attempt started or finished, a unit accepted or
returned, escalations, pauses, staging) and exits when the run is staged, failed, or needs the
user. Every line it prints is news for the user: answer each one with one short sentence
(`T2 attempt 2 started`, `T2 accepted`, `T2 returned: tests fail`), and a `still working` line
means the build is alive, so say that too. Never let a watch line go by without telling the user.
Don't wait for the user to ask how it's going. In Codex there is no streaming: look at `heph watch <run>` or `heph status <run>` whenever
you come back to the conversation.

When `heph watch` ends with `waiting for you` or `the planner escalated`, don't retry and don't
spend more attempts: run `heph explain <run> <unit>`, say plainly what is blocked (a criterion a
later task owns, a file outside the unit's scope, a decision the Brief got wrong), and ask the
user how to go on: a hint (`--scope` for a file), a plan revision, or a new Brief.

`heph status <run>` shows where a run is at any time; `heph status` lists all runs.
`heph cancel <run>` stops one for good; only do that when the user asks.

## 5. Stacking and parallel units

**Stacking.** When the user wants a change that builds on another run's unmerged work, submit it
with `heph new --brief <file> --stack-on <run>` (the parent must be `built` or `staged`). The
child builds on the parent's branch and stages on its own; `heph status <child>` shows
`stacked on <parent> (<status>)`. It cannot be merged before its parent: `heph watch <child>`
ends with `waiting for <parent>`, and `heph approve merge <child>` says the same until the parent
is finished. The child is restacked onto the target (and its pull request base moved) only when
the user runs `heph approve merge <parent>` or `heph merge status <parent>`; a parent merged on
GitHub directly stays `staged` until `heph merge status <parent>` is run, so tell the user that
command. If the parent failed or was cancelled, watch says `rebuild <child>`: explain to the
user; it can only be rebuilt. If a restack stops on a conflict or a red check, the child is
`paused`: show the user `heph explain <child>`. Once the cause is fixed they run `heph run
<child>`, then `heph approve merge <child>`, which only restacks and retargets and does not merge,
then review and run `heph approve merge <child>` once more to merge. Never run any of these
approvals yourself.
Don't stack unless the user asked or the second change really needs the first.

**Parallel units.** `limits.parallel` (default 3; `heph config explain` shows it) lets independent
units of one plan build at the same time. It is the user's setting: don't change it;
`1` restores the strictly sequential order. With it above 1, `heph status <run>` lists the attempts in flight, and a pause waits for the ones
running to finish first. Everything else (hints, escalations, watching) works the same.

**Measuring.** `heph stats` answers whether the harness is paying off (how many runs reached
merge cleanly, from the ledger); `heph eval` measures a change to prompts, roles or routing
against golden tasks before it becomes the default. Both are the user's to run; offer them, and
don't run `heph eval` yourself: it spends real model calls.

## Don'ts

- Don't run `heph approve ...`, ever, even if asked to "just approve it": tell the user the
  command instead.
- Don't edit `heph/<run>` branches, heph's worktrees, or `~/.heph`. If a run's result needs
  changes, that's plan feedback, a hint, or a new run.
- Don't implement the change yourself while heph is working on it.
