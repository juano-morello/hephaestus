# The eval runner and the kill-criteria report (2026-11-07)

Sub-project F (eval and learning) of `docs/ROADMAP.md`: the measuring tools. Retro, learned routing and extra worker backends are deliberately not part of this.

## Problem

Checked in the source on 2026-11-07:

- Golden tasks exist as a schema, a loader and a checker (`packages/core/src/eval`, `scripts/eval-check.ts`), with a private suite of real briefs at `~/Workspaces/heph-evals/legendsao`. There is no runner: `heph eval` does not exist, so SPEC §14's rule "any change to prompts, roles, routing or engine logic gets an eval run before becoming default" cannot be followed, and planner-side measurements go through the `plan-proto` developer script.
- SPEC §18 sets kill criteria (fewer than half of runs reach merge without manual rewriting, after four weeks of runs), but nothing computes the first one. The ledger has the data (run outcomes, hints, replans, escalations, stalls).
- The ledger already carries an `eval` flag on `run.created` and in its projections, but nothing sets it.
- Retro and learned routing need real ledger volume (SPEC: "built last"); only a handful of real runs exist. No second worker backend has been named.

## Decisions (2026-11-07)

- Scope: the runner with `compare`, and the kill-criteria report (chosen over the report alone, and over adding a named extra backend).
- A clean run is defined strictly: merge-ready (staged or finished), exactly one plan, no hints, no escalations, no stalls (chosen over letting hints through, and over reporting counts with no headline).
- Results are JSON files in the suite's repo (default `<suite>/results`), not a new projection.
- Out of scope, recorded as decided-not-now: retro and the constraint store, learned routing, extra worker backends, a shared results store, parallel eval runs.

## 1. `heph eval`

- Commands (SPEC shape): `heph eval --suite <dir> [--task <id>]... [--tag <t>]... [--runs N] [--label L] [--out <dir>] [--resume]` and `heph eval compare <labelA> <labelB> [--suite <dir>] [--fail-on-regression]`. Tasks that `eval-check` reports `needs_oracle` or `invalid` are skipped and listed with the reason.
- Per task and run, in a throwaway directory under the eval home:
  1. Clone each repo named in `workspace_ref` from the suite's `workspace.yaml` repo paths (`--no-hardlinks`), check out the pinned commit, create the target branch at the pin, and remove every remote, so nothing can push or open a PR.
  2. Write `.heph/workspace.yaml` from the suite's workspace file. Each repo's `.heph/config.yaml` comes from `<suite>/repo-configs/<repo>.yaml` if present, else is copied from the real repo's working copy.
  3. Open a runtime with the user's real node config (models, routing, from their `HEPH_HOME`) and a throwaway ledger home, create the run flagged `eval` (a new `eval` option on `newRun` that sets the existing `run.created` flag), plan, auto-approve and build. Nothing lands.
  4. Check the oracle on the run branch's tip in a fresh checkout: copy the hidden tests to their `to` paths, run each `must_pass` command in the same kind of sandbox the gates use (the node config's sandbox mode), and check `must_not_touch` against the diff from the pin. Solved means every command exits 0 and no forbidden path changed. For `expect: escalate` tasks, solved means the planner returned an Escalation; an Escalation on a task with an oracle is a false escalation.
- Metrics per run, from the throwaway ledger: solved, first-pass plan validity (`plan.answer` attempt 1), attempts per unit, escalations, stalls, scope violations (red `diff_scope` results), tokens, wall time.
- Results: `<out>/<label>/<task>/run-<k>.json` and a `summary.json`; the default `<out>` is `<suite>/results`. `--resume` skips runs whose result file exists. A run that throws records `error` with the message and the eval continues.
- `compare` reads two labels and prints each metric in aggregate and per task, with the mean and the min-to-max spread across runs. `--fail-on-regression` exits 1 when the solved rate or first-pass plan validity drops by more than the spread.

## 2. `heph stats`

- `heph stats [--since 28d|<date>] [--list] [--json]`, read-only, computed from this node's ledger (synced runs included), default window 28 days, runs flagged `eval` excluded.
- Classification per run created in the window, from events only: merge-ready (`staged` or `finished`); clean (merge-ready with exactly one `run.plan_ready`, no `human.input`, no `unit.escalated`, no `unit.stalled`); assisted (merge-ready, not clean); did not merge (`failed`, cancelled, or planner-escalated); open (not counted).
- Headline: clean runs over all runs that are no longer open (clean + assisted + did not merge), with a plain line saying whether it is above or below the SPEC's 50% line; `n/a` with no closed runs. Also each count, and the hint, replan, escalation and stall totals across assisted runs. `--list` prints one line per run with its class and reasons.
- Every output carries a footer: it cannot see manual edits made outside heph or on GitHub after a PR was opened, nor work done in direct sessions; the second SPEC criterion ("work keeps bypassing the harness") is not measurable from the ledger.
- Code: a pure `classifyRuns(...)` over the ledger's runs and events, called by a `Runtime.stats(window)` read method and a host case. No ledger event or schema changes.

## 3. Docs and rollout

- SPEC §14 as-built (runner, throwaway workspace, metrics, results layout, `compare`); §16 CLI list gains `heph eval` and `heph stats`; §18's kill criteria note the report and what it cannot see. NOTES "Eval runner and stats (2026-11-07)", with the old "eval not built" lines corrected; ROADMAP's F line updated; one line each in the chat-host skill and its Codex copy (kept identical by the existing test).
- Decided not now, with what would reopen each: retro and the constraint store (a few dozen closed runs in `heph stats`), learned routing (same; the router already records `routed` per unit), extra worker backends (a named backend), a shared results store, parallel eval runs.
- `plan-proto` stays for planner-only measurements and the planner-gates runbook; `eval-check` stays as the suite validator.
- The runner writes only under its eval home and the suite's results directory, never to the real ledger or repos.
- A live `heph eval` run is not part of the build: it needs real model calls, the real game repo and OMP, none of which work in the agent sandbox. The runner is verified with scripted planners and workers and temporary git repos; the user's first live run is the acceptance test (suggest `--runs 1 --task <one small task>`).

## Testing

- Runner (scripted planner and worker, temporary git repos): workspace setup (pins checked out, remotes removed, workspace and repo configs written from the suite or the real working copy), a solved run, an unsolved run (a `must_pass` command failing, a forbidden path touched), a should-escalate task solved and missed, a false escalation, an erroring run recorded and skipped past, result files and `--resume`, skipped `needs_oracle` tasks listed.
- Metrics extraction from a seeded throwaway ledger.
- `compare`: two labels with several runs each, mean and spread, a regression and `--fail-on-regression` exit codes.
- `newRun` with the `eval` option writes the flag; runs without it are unchanged.
- `heph stats`: a fixture ledger with one run of each class; window filtering; eval runs excluded; an empty ledger; a run with one hint is assisted; a replanned run is assisted; a cancelled run did not merge; `--list` reasons; the `--json` shape; the footer is always present.

## Not changed

The engine, the planner, gates, routing, and existing ledger events and projections.
