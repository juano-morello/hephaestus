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
| Dashboard (§16) | First slice only: read-only runs list and run page (`heph ui`). |
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

- **A. Planner quality.** Built 2026-11-06 (see NOTES "Planner paths"); original scope: Plan gate matching scope globs against the worktree file list; execution gate requiring locked tests to be red before the implement task; repo maps generated from real repos; `heph plan` CLI surface; `Criterion.projects`; narrowing the Return's scope to failing files.
- **B. Authoring surface.** Workflows, presets, `--dry-run`, custom gates from `.heph/gates/`, JSON Schema generation from the zod schemas, extra gates (coverage delta, requirement-to-check mapping, Godot project-imports-headless).
- **C. Routing and limits.** Built 2026-11-06 (NOTES "Routing"): start-tier router, escalation ladder with `top`, fallback provider with cooldown. Not built: remaining-budget tracking per provider, and fallback on provider outages (needs worker failure classes).
- **D. Run control.** Interrupt an in-flight worker on `heph cancel`; handoff that waits for in-flight attempts.
- **E. Dashboard and widgets.** Hint and cancel buttons, plan review, diff summary, ledger charts, SSE, remote-node views, fix the stale-port token leak, then MCP Apps widgets with HTTP transport (needs its own auth design; host support for MCP Apps is an open question).
- **F. Eval and learning.** Verify `heph eval` and the kill criteria; retro and constraint store; learned routing; extra worker backends.
- **G. Housekeeping.** `heph nodes`, daemon as an installed service, `--set` through the daemon, MCP follow-ups (NOTES.md "MCP server: follow-ups").

## Order

A first: it most directly affects run success, and later work builds on a reliable planner. Remaining order to be decided after A.
