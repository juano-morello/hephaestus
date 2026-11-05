# Stall detection: stop a unit that fails the same way twice

Status: design, awaiting approval. Date: 2026-11-05.

## Problem

On the first LegendsAO runs (docs/NOTES.md, "First real runs on LegendsAO" and "Following a run
from the chat host") a unit failed the same check on three attempts in a row (63 of 64 passing),
escalated, and would have been given three more attempts before anyone was asked. More attempts
cannot change a failure that is structural (a criterion outside the unit's scope, an unreachable
plan). `heph watch` shows the escalation but only after the attempts are spent.

## Goals and constraints

- Detection is code over ledger events, never model judgment.
- A repeated failure pauses the run for the user before the remaining attempts are spent.
- `heph watch` ends on it ("waiting for you"); the skill tells the agent to explain and ask.
- Changes stay on the escalation path of `runUnit` (SPEC section 10); no new plan-level logic.

## Design

### Failure signature

`stallSignature(feedback: Return): string`, a pure function in `packages/engine`. It takes the
failing reasons of a red attempt (`Return.reasons`: gate, reason, evidence), formats each as
`gate | reason | evidence...`, sorts them, joins and hashes. Digits are not normalised, so
"63 of 64" and "62 of 64" differ. A noisy reason can only miss a stall, never invent one.
Green attempts have no signature.

### Detection

`isStalled(events)`: over a unit's events since the latest plan, true when the last two
`unit.returned` payloads (attempt order) have the same signature. Rules:

- Spans `unit.escalated`: a model bump never re-runs a failure that already repeated.
- Resets at any `human.input` addressed to the unit (hint, scope, constraint) and at a new plan,
  because the situation changed. The comparison only looks at `unit.returned` events after the
  last such reset.
- `blocked` and interrupted attempts produce no `unit.returned`, so they are unaffected.

The threshold is fixed at 2 (not configurable; YAGNI until a run shows a need).

### Engine

In `runUnit`, right after a red attempt's `unit.returned` is appended, check `isStalled`. If true,
append in one `appendMany`:

1. `unit.stalled` `{ signature, attempts: [n-1, n], failing: [{ gate, reason }] }`
2. `run.paused` `{ reason: "user" }`

and return `{ status: "paused", reason: "stalled: <gate> failed the same way on a<n-1> and a<n>" }`.
The remaining attempts and the tier bump are skipped. Resuming after a hint is unchanged: the
unit's history resets on the `human.input`.

`unit.stalled` is added to SPEC section 6 (event types) and noted in section 10 (Escalation).
Unknown-event handling already tolerates readers that predate it.

### Watch

`packages/cli/src/watch.ts`: add `unit.stalled` to `MILESTONES`. The run ends through the
existing `run.paused` "waiting for you" path, so the output is
`T2 stalled: tests failed the same way on a1 and a2`, then `waiting for you`.

### Skill text

`packages/cli/src/install-files.ts`: on a stall, explain the repeated failure and ask the user.
Offer: widen scope with `heph hint --scope`, a hint, or revising the Brief. Never retry or hint
without the user.

### Testing

- Unit: signature stable and order-independent; differs on different evidence; repeat detected;
  spans escalation; resets on `human.input` and on a new plan; blocked/interrupted ignored.
- Engine: a fake runner failing identically twice pauses with `unit.stalled` and no third attempt.
- Watch: the new line is a milestone and the run ends as waiting for you.

## Out of scope

Near-duplicate signatures, a configurable threshold, plan-level stalls (different units failing
the same way), MCP progress notifications.
