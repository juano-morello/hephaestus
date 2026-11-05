# Stall Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pause a unit for the user as soon as two consecutive red attempts fail the same way, instead of spending the rest of its attempts.

**Architecture:** A pure module (`packages/engine/src/stall.ts`) computes a failure signature from a `Return` and decides, from a unit's events, whether it is stalled. `runUnit` checks it after each red attempt and, on a stall, appends the new `unit.stalled` event plus `run.paused` (user). The ledger, `heph explain`, `heph watch`, the skill text and the SPEC learn the event.

**Tech Stack:** TypeScript on Bun (`bun test`), zod event schemas in `@hephaestus/ledger`.

**Spec:** `docs/superpowers/specs/2026-11-05-stall-detection-design.md`

## Global Constraints

- Detection is code over ledger events, never model judgment.
- Threshold is fixed at 2 consecutive identical signatures; not configurable.
- Spans `unit.escalated`; resets at a `human.input` for the unit (or the whole run) and at a new plan.
- Digits in reasons are not normalised.
- Engine changes stay in `runUnit`'s escalation path and `unitHistory`; other sessions edit other regions of `engine.ts`.
- Commits: NEVER add Co-Authored-By or any AI/Claude attribution (CLAUDE.md).

## Review Focus

- Two reds with the same gate but different evidence (different failing test) must NOT stall.
- A hint between two identical reds must NOT stall on the next identical red.
- `heph resume` with no hint after a stall: the unit gets fresh attempts (`used` resets) and re-stalls after one more identical red, not zero.
- Green or `blocked` attempts between reds: `blocked` produces no `unit.returned`, so reds on either side still compare.
- A `unit.stalled` event written by a newer engine must not break `explain`/projection readers (projection marks the unit `escalated`).

---

### Task 1: Signature and detection (pure)

**Files:**
- Create: `packages/engine/src/stall.ts`
- Modify: `packages/engine/src/index.ts` (add `export * from "./stall.ts";`)
- Test: `packages/engine/test/stall.test.ts`

**Interfaces:**
- Produces:
  - `stallSignature(r: Pick<Return, "reasons">): string`: sort `"<gate> | <reason> | <evidence.join(" / ")>"` lines, join with `\n`, sha256 via `node:crypto`, return the first 12 hex chars.
  - `isStalled(events: LedgerEvent[], unitId: string): { attempts: [number, number]; signature: string } | undefined`: `events` are the run's events since the latest plan in ledger order (as `sinceLatestPlan` returns). Considers only that unit's `unit.returned` events after the last `human.input` whose `unit_id` is absent or equals `unitId`. Returns the last two attempt numbers when their signatures are equal, else `undefined`.

- [ ] **Step 1: Write the failing tests** in `stall.test.ts`, building events as plain objects `{ type, unit_id, attempt, data }` cast to `LedgerEvent`: (a) `stallSignature` equal for the same reasons in a different order, different when evidence differs, different for "63 of 64" vs "62 of 64"; (b) `isStalled` returns `{attempts: [1, 2], signature}` for two identical returns; (c) `undefined` for one return, for two with different evidence, for returns of another unit; (d) identical returns separated by a `unit.escalated` still stall; (e) a `human.input` (unit-scoped, and run-scoped with no `unit_id`) between them yields `undefined`, but two identical returns after it stall; (f) a `human.input` for a different unit does not reset.
- [ ] **Step 2: Run** `bun test packages/engine/test/stall.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `stall.ts` per the Interfaces block.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): detect a unit failing the same way twice`

### Task 2: The `unit.stalled` ledger event

**Files:**
- Modify: `packages/ledger/src/events.ts` (next to `unit.escalated`, line ~131), `packages/ledger/src/projections/apply.ts` (next to `unit.escalated`, line ~186), `packages/ledger/test/samples.ts` (next to `unit.escalated`, line ~118)
- Test: the ledger's existing sample-driven tests (run `bun test packages/ledger`)

**Interfaces:**
- Produces: event `unit.stalled`, unit-scoped like `unit.escalated`, data `{ signature: string; attempts: [number, number]; failing: { gate: string; reason: string }[] }` (`.strict()`; attempts positive ints; failing min 1).

- [ ] **Step 1: Add** a `unit.stalled` sample in `samples.ts`. Run `bun test packages/ledger`. Expected: FAIL (unknown event type).
- [ ] **Step 2: Define** the schema with `def(..., UNIT)` in `events.ts`; in `apply.ts` handle `unit.stalled` like `unit.escalated` (`setUnitStatus(db, e, "escalated")`).
- [ ] **Step 3: Run** `bun test packages/ledger`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(ledger): unit.stalled event`

### Task 3: Engine pauses on a stall

**Files:**
- Modify: `packages/engine/src/engine.ts`: `unitHistory` (line ~279: treat `unit.stalled` like `unit.escalated`, `h.used = 0`) and `runUnit` after the red attempt's `appendMany([...finished, unit.returned])` (line ~722)
- Modify: `packages/engine/test/engine.test.ts` (the "three reds" test at line ~291) and any other test the change breaks (`resume.test.ts` "more attempts" cases): fix by making the fake worker's failures differ in evidence per attempt where the test is about exhausting attempts, not stalls.
- Test: `packages/engine/test/engine.test.ts`

**Interfaces:**
- Consumes: `isStalled(events, unitId)` from Task 1 using `sinceLatestPlan(ledger, ctx.runId)`; `unit.stalled` from Task 2.
- Produces: on a stall, one `ledger.appendMany` of `unit.stalled {signature, attempts, failing: feedback.reasons.map(({gate, reason}) => ({gate, reason}))}` then `run.paused {reason: "user"}` (both with `engine` actor fields); `runUnit` returns `{ status: "paused", reason: "stalled: <first gate> failed the same way on a<n-1> and a<n>" }`.

- [ ] **Step 1: Write failing tests**: (a) a fake worker failing identically twice (same gate reason and evidence) → result `{status: "paused", reason: "T1: stalled: impl failed the same way on a1 and a2"}` (the caller prefixes the unit id as in the existing reason), exactly 2 worker calls, ledger has `unit.stalled` then `run.paused`, unit status `escalated`; (b) the same fake worker with a `human.input` hint appended between attempts 1 and 2 is not possible mid-run, so instead seed the ledger with a first red + hint, run, and assert the next identical red does not stall; (c) reds with different evidence per attempt still run 3 attempts and escalate as before.
- [ ] **Step 2: Run** `bun test packages/engine/test/engine.test.ts`. Expected: new tests FAIL; the old three-reds test fails once step 3 lands until updated.
- [ ] **Step 3: Implement** in `runUnit` after appending `unit.returned`: `const stall = isStalled(sinceLatestPlan(ledger, ctx.runId), t.id)`; if set, append the two events and return paused as in Interfaces. Update `unitHistory`.
- [ ] **Step 4: Update** the three-reds and resume tests as noted. Run `bun test packages/engine`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(engine): pause a unit that fails the same way twice`

### Task 4: Explain, watch, skill text

**Files:**
- Modify: `packages/cli/src/runtime.ts` (`describe`, line ~642: `case "unit.stalled"` returns `` `stalled: ${failing gates} failed the same way on a${a} and a${b}` ``), `packages/cli/src/watch.ts` (`MILESTONES` gains `"unit.stalled"`), `packages/cli/src/install-files.ts` (skill text: on a stall, explain the repeated failure and ask; offer `heph hint --scope`, a hint or a revised Brief; never retry or hint unasked)
- Test: the CLI's existing watch and install-files tests (find with `ls packages/cli/test`); add to them.

**Interfaces:**
- Consumes: `unit.stalled` data from Task 2.

- [ ] **Step 1: Write failing tests**: `describe` of a `unit.stalled` event reads `stalled: impl failed the same way on a1 and a2`; `isMilestone` is true for it; `watchRun` over a view whose events end with `unit.stalled` then `run.paused` ("waiting for you") prints the stalled line then `waiting for you` and returns `{status: "paused", reason: "waiting for you"}`; the installed skill text contains the stall guidance (assert on a distinctive phrase you add, e.g. "failed the same way").
- [ ] **Step 2: Run** `bun test packages/cli`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the three edits.
- [ ] **Step 4: Run** `bun test packages/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): explain and watch show a stalled unit; the skill says to ask`

### Task 5: Docs and full check

**Files:**
- Modify: `docs/SPEC.md` (section 6 event list: add `unit.stalled (signature, attempts, failing)`; section 10 Escalation: a unit whose last two red attempts share a failure signature pauses for the user early, across escalations, reset by `human.input`; section 16 `heph watch` if it lists milestones), `docs/NOTES.md` (in "Following a run from the chat host" replace "Not built: ... detecting a structural stall" with what was built, and list the new decisions: threshold 2, hint resets, signature definition)

- [ ] **Step 1: Edit** the docs.
- [ ] **Step 2: Run** `bun test` (whole repo) and the repo's typecheck/lint scripts from `package.json`. Expected: all PASS.
- [ ] **Step 3: Commit** `docs: stall detection in the spec and notes`

---

## Self-review

Spec coverage: signature, detection rules (span, reset, threshold) → Task 1; event + projection → Task 2; engine behaviour, resume → Task 3; watch, explain, skill → Task 4; SPEC/NOTES → Task 5. Names match across tasks (`stallSignature`, `isStalled`, `unit.stalled` data fields). Known cost: existing tests that fail identically three times now stall at two; Task 3 step 4 covers them.
