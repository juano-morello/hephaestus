# Routing: start-tier router, escalation ladder, fallback provider (2026-11-06)

Sub-project C of `docs/ROADMAP.md` (routing and limits). Implements SPEC §10 escalation and the fallback part of §10/§17; per-provider remaining-budget tracking is out of scope (OMP gives no quota signal).

## Problem

Checked in the code on 2026-11-06:

- A unit's route is `resolveRoute(config, role, tier)` (packages/engine/src/config.ts) with the plan's tier, bumped only by `complexitySanity` (up, never down). Attempts and escalations never change it: a unit that fails three times on haiku never tries sonnet, and the SPEC's "sonnet high -> opus" rung does not exist in config.
- The planner's `complexity` is a guess. Nothing uses what can be measured before the attempt, and a clearly small task cannot start cheaper than the planner rated it.
- A rate limit pauses the whole run and waits `retry_after` (60 s default, since OMP reports a 429 without one). A role cannot use another provider meanwhile.

## Decisions (2026-11-06)

- Ladder: the existing tiers plus one optional `top` rung per role (chosen over tiers-only and over an explicit per-role `ladder:` list).
- Start tier: a deterministic router over measurable signals, allowed to go below the planner's rating because the ladder climbs on failure (chosen over a model judge, and over both). Learned routing from ledger data stays v2.
- Fallback: one optional per-role fallback route with an in-memory provider cooldown (chosen over per-attempt fallback and over pause-always).
- Out of scope: per-task tier overrides in plan review, reviewer-role routing, remaining-budget tracking, `diversify`, and fallback on provider outages or auth errors (worker failures carry only `timeout`/`idle`/`error` with free text; classifying a provider failure needs the worker to report a failure class, a follow-up).

## 1. Start-tier router

`routeTier(task: Task, signals: RouteSignals): { tier: Complexity; score: number; reasons: string[] }`, a pure function in `packages/core/src/router.ts`.

`RouteSignals`, all known before the attempt:

- files matched by the task's scope in its project, and their total lines (read from the run-branch tip when the unit starts, after its predecessors are accepted, not at build start; the decision is persisted in `routed` on the unit's first attempt, so a resume reuses it);
- number of criteria the task covers;
- the task's lane and kind;
- whether it consumes an artifact produced in another project;
- the planner's `complexity`, as one vote.

Rules:

- Today's `complexitySanity` floors stay: lane `wide` or `irreversible` is at least `standard`; consuming another project's artifact is at least `standard`.
- Above the floors a weighted score picks `trivial`, `standard` or `complex`. The planner's rating is one vote, not an override, so the result may be below it.
- `trivial` requires all of: lane `contained`, 2 or fewer matched files, 150 or fewer total lines, 1 or fewer covered criteria, no cross-project input.
- Thresholds and weights are constants in code, not config.
- The engine builds each unit's starting tier (`tiers` in engine.ts, built from the plan and the sanity bumps) from `routeTier`.

## 2. Escalation ladder

- Rungs: `trivial -> standard -> complex -> top`. `Routing` accepts an optional `top` route per role. Defaults add `top` for `implementer` and `test_author` (`claude/claude-opus-5-5`, effort `high`). A role without `top` stops at `complex`.
- Each `red` attempt adds one rung to the next attempt. `blocked` goes to replan with no bump; `error` (transport) is not a model failure, no bump; interrupted and rate-limited attempts never count (as today). A stall still pauses the run at once.
- The rung is derived from the ledger, never stored: the router's start tier plus the number of `red` attempts of the unit since the latest plan, capped at the top rung. Resume, crash and hints never lose it. A hint after an escalation keeps the higher rung. With `attempts_per_unit: 3`, attempts 1 to 3 run at the start tier, one rung up and two rungs up; the fresh budget after an escalation starts at the unit's current rung.
- `resolveRoute(config, role, rung)` takes a rung (`Complexity | "top"`), falling back to `default`. `attemptTimeoutByTier` treats `top` like `complex`.

## 3. Fallback provider with cooldown

- Config: optional `fallback` route per role (not per tier), on another provider. None by default, so behavior is unchanged until set.
- Cooldown: a rate-limited attempt marks its provider cooling until `retry_after`, or 60 s when absent. The state is an in-memory map in the build context; a crash loses it, which is harmless (the next 429 sets it again).
- Routing: each unit resolves its ladder route first. If that route's provider is cooling and the role has a fallback on a different provider that is not cooling, the unit uses the fallback route.
- A rate-limited attempt is still recorded `unit.attempt.interrupted` with reason `rate_limit` and does not count. The same unit is retried at once on the fallback.
- The run pauses with `run.paused` `rate_limit` only when no usable fallback exists (none configured, also cooling, or same provider). The resume ramp is unchanged.

## 4. Data and surfaces

- `AttemptInfo` (shared by `unit.attempt.started` and `.finished`, strict, packages/ledger/src/events.ts): `tier` widens to `Complexity | "top"`; optional `routed: { tier, score, planner_tier, reasons }` on a unit's first attempt only; optional `fallback_for: string` (the primary provider). No new event types and no projection change; places that assume `tier` is a `Complexity` (the attempts projection, `heph explain`, dashboard labels) are widened. Strict event schemas already rule out mixed-version nodes (as with `stack_on`); note it in NOTES.
- `Routing` accepts `top` and `fallback` per role; `heph config explain` and `heph doctor` list them and doctor probes them like tier routes.
- Code: `packages/core/src/router.ts`; `resolveRoute` and ladder rung derivation in `packages/engine/src/config.ts` and next to `unitHistory` in `engine.ts`; the cooldown map in the build context where attempts are dispatched.

## Testing

- Router: table tests per signal combination and floors, including a case that qualifies as `trivial` and one that fails it on a single signal.
- Ladder: red bumps; `blocked`, `error` and `interrupted` do not; the rung survives a simulated resume; capped at `complex` when a role has no `top`.
- Fallback: a 429 marks cooling; the next unit uses the fallback; the primary returns after the cooldown; with no fallback the run pauses as today. Existing rate-limit tests stay green.
- Back-compat: a config without `top` or `fallback` behaves as before apart from the router's start tier.

## Measurement

The router's thresholds are first guesses. After a few real runs, compare `routed.tier` with the final rung per unit; that is the evidence for tuning and the seed data for learned routing (v2).

## Not changed

Planner routing, stall detection, the correction loop, gates, and the ledger's event types.
