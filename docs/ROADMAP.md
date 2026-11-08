# Roadmap (2026-11-06)

SPEC built-vs-pending map, and the decomposition of what comes next. Sources: `SPEC.md`, `NOTES.md`. Items marked (?) come from older notes and were not checked against the code.

Out of scope for now (decided 2026-11-06): leases and heartbeats for cross-node runners, v1.5 approvals, the npm scope.

## Built

| Area (SPEC §) | State |
|---|---|
| Planner prototype, plan gates (§19 step 0, §8) | Built. First-try validity ~97%, one-correction loop, `plan.answer` events. |
| Golden tasks (step 1) | Built. |
| Ledger, projections, blob store (§6) | Built, projection version 4. |
| Engine, up to 3 attempts per unit (§2) | Built. |
| OMP worker in a sandbox (§12) | Built, container and native (`sandbox-exec` / `bwrap`) modes. |
| Gates (§11) | Built: tests, diff-scope, typecheck, lint, locked paths, touched-vs-diff, integration. |
| Multi-repo changesets, PR landing, set merge | Built. |
| CLI with `--json` (§16) | Built. |
| Resume and idempotency (§13) | Built. |
| Node model (§7) | Built over SSH: sync, single-owner writes, handoff, `--on`, daemon. |
| MCP server (§16) | Built (`heph_*` tools, installer, skill). |
| Dashboard (§16) | Read-only: runs list, run page with graph, plan review, diff summary and ledger charts, overview strip (`heph ui`, with a token challenge). No write buttons yet. |
| Stall detection (§6, §10) | Built. |
| Parallel fan-out and stacking (§19 step 3) | Built. `limits.parallel` defaults to 3, with a rate-limit ramp. |
| Routing: start-tier router, escalation ladder, fallback provider (§10, §17) | Built 2026-11-06, except remaining-budget tracking and provider-outage fallback. |

## Unclear (?) — verify first

- `heph eval` and §14 metrics: `packages/core/src/eval` exists; a 2026-11-03 note lists `eval` as not built in the CLI.
- §18 kill criteria (4 weeks after v0 runs): no evidence it was evaluated.

## Decided not to build (revisit on need)

- Multiple stack parents, optimistic joins (revisit on a real diamond-shaped need).

## Sub-projects

Each gets its own spec, plan and build.

- **A. Planner quality.** Built (2026-11-06/07). Built: the `creates` gate for guessed paths and the collapsed repo map (NOTES "Planner paths"); over-wide test globs rejected, `test_scope_narrow` (NOTES "Test scope gate"); `Criterion.projects` (NOTES "Criterion.projects"). Deliberately dropped for now: the red-first execution gate (test units already require red; only a right-reason red is missing, which needs per-stack test-output parsing), narrowing the Return's scope to failing files (not worth building until seen in real runs), a planner file-listing tool (NOTES "Planner file-listing tool"), and a separate `heph plan` surface (`heph run --dry-run` covers the preview; `plan-proto` evaluates plan files by hand). Still to do, by you: the live before/after measurement of the planner gates (NOTES "Measuring the planner gates (runbook)"); it needs real model calls.
- **B. Authoring surface.** Closed (2026-11-07). Built: `heph run --dry-run`, JSON Schema (`heph schema`, written by `heph init`), append-only role prompt files, and custom command gates (a `gates` map of commands run in the sandbox on the units covering a criterion that names them, plus `always` gates; NOTES "Custom command gates"). Decided not now, with reasons and what would reopen each (NOTES "Closing B"): workflows, presets, a built-in coverage delta (the coverage, buf and Godot checks are recipes for custom gates in NOTES), and TS gate files (unsafe to run in the engine process).
- **C. Routing and limits.** Built 2026-11-06 (NOTES "Routing"): start-tier router, escalation ladder with `top`, fallback provider with cooldown. Not built: remaining-budget tracking per provider, and fallback on provider outages (needs worker failure classes).
- **D. Run control.** Built 2026-11-06 (NOTES "Handoff wait"): `heph handoff --wait [seconds]` with a drain signal in the engine; cancel under a daemon already interrupts the attempt in flight (now pinned by a test). Not built: cancel across processes without a daemon and Ctrl-C handling in `heph run`; aborting gate commands on cancel (unverified).
- **E. Dashboard and widgets.** MCP Apps: the plan review widget (2026-11-07, NOTES "MCP Apps plan widget") and the run view widget (2026-11-08, NOTES "MCP Apps run widget") are built, served by the stdio `heph mcp` server (no HTTP transport or auth design needed); the run view has Refresh and 5 s polling only where the host has `serverTools` (Codex yes, Claude desktop no). Remaining ideas: a diff summary and charts widget need new read-only MCP tools first. Actions beyond Refresh (cancel, hint) are decided not now; approve stays out. The read-only slice is built (2026-11-07, NOTES "Dashboard views and token challenge"): plan review, changeset diff summary (file names and counts, no diff text), ledger charts and an overview strip, plus the stale-port token fix (`heph ui` proves the listener holds the token before handing it over). Decided not now: hint and cancel buttons (writes are 404 even with the token, so they need a write-surface design first), SSE (polling works), remote-node dashboards, provider usage versus limits (no quota signal), a gate statistics panel.
- **F. Eval and learning.** The measuring tools are built (2026-11-07, NOTES "Eval runner and stats"): `heph stats` (the kill-criteria report from the ledger: clean, assisted, did not merge, with what it cannot see), `heph eval` (a golden-task runner on throwaway workspaces with no remotes, hidden oracle, metrics, JSON results) and `heph eval compare` (run-to-run spread, `--fail-on-regression`). Not yet exercised live: the first `heph eval` run against the private suite is the acceptance test (`--runs 1 --task <one small task>`). Decided not now: retro and the constraint store, learned routing (both wait for a few dozen closed runs in `heph stats`), extra worker backends (a named backend), a shared results store, parallel eval runs.
- **G. Housekeeping.** Built (2026-11-08, NOTES "Housekeeping (2026-11-08)"): `heph nodes [--probe]`, `--set` refused when a daemon would serve the command, a cap on reusing an in-flight peer sync, the Codex `config.toml` edit aware of multi-line strings. The daemon as an installed service was already built by `install:heph`. Passing `--set` through the daemon is decided not now.

## Order

All sub-projects A to G are built or closed (G on 2026-11-08); what is left under E and F is listed as decided not now above.

E's read-only slice and F's measuring tools were built on 2026-11-07. Next: the rest of E and F as chosen.
