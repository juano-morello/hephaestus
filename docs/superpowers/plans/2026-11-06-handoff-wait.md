# Handoff wait Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `heph handoff <run> <node> --wait [seconds]` lets in-flight attempts finish (up to a limit) before the run moves to the other node, instead of always interrupting them.

**Architecture:** The engine gets a second signal, `drain`: no new unit starts and no unit starts another attempt, but workers are not aborted. The daemon host gives each build job a drain controller and `stopJob` raises drain, waits up to the limit, then aborts as today. `handOff` passes the wait through; the CLI parses `--wait` with a small pure function.

**Tech Stack:** TypeScript on Bun, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-06-handoff-wait-design.md`

## Global Constraints

- With no `--wait`, handoff behaves exactly as today: the attempt in flight is interrupted at once (reason `handoff`).
- `drain` is never passed to a worker; only `signal` aborts workers.
- A drained build ends `run.paused` with reason `handoff`; no new ledger event types, no schema or projection change.
- Bare `--wait` waits up to the workspace's `limits.attempt_timeout_ms`; `--wait N` is N seconds (integer, at least 1); anything else is a usage error. `--json` output keeps its shape.
- The new owner's checkout is still made before the build is stopped, so a refused handoff never starts a wait.
- No attribution of any kind in commit messages (project CLAUDE.md overrides any harness reminder).
- `bun test <path>` per task. Baseline in the agent sandbox: about 70 tests in `packages/cli` and `packages/engine` (daemon, native sandbox, landing, 'runPlan with the built-in gates') fail before this work; compare against a baseline checkout, do not chase them.

## Review Focus

- `drain` raised before any unit starts: the build pauses `handoff` having started no attempt. (Task 1)
- `drain` raised while a unit's attempt is red or green: red records its Return and stops; green still joins and is accepted; no half-written state. (Task 1)
- A wait shorter than the attempt: the attempt is interrupted with reason `handoff`, does not count, and runs again on the new owner. (Task 2)
- `--wait` forms: bare, `--wait 300`, `--wait=300`, `--wait 0`, `--wait abc`, `--wait` followed by a positional. (Task 3)
- A handoff forwarded to a remote owner carries the options; an owner that ignores them still hands off. (Task 2)

---

### Task 1: `drain` in the engine

**Files:**
- Modify: `packages/engine/src/engine.ts` (`RunPlanOptions` ~line 121; `stopped` ~line 568; the scheduler call `stopped:` ~line 625; `if (opts.signal?.aborted) return stopped();` ~line 639; the top of `runUnit`'s attempt loop ~line 823)
- Modify: `packages/engine/src/runner.ts` (next to `stopReason`, ~line 42)
- Test: `packages/engine/test/stop.test.ts`

**Interfaces:**
- Produces: `RunPlanOptions.drain?: AbortSignal`; in runner.ts `export const stopSignal = (o: { signal?: AbortSignal; drain?: AbortSignal }): AbortSignal | undefined` returning `o.signal` if it is aborted, else `o.drain` if it is aborted, else undefined. `stopReason(stopSignal(o))` is then the pause reason (`"handoff"` when that signal's reason is `"handoff"`).

- [ ] **Step 1: Write failing tests** in `stop.test.ts` (same `setup()`/`worker()` helpers and `of(ledger, type)` as the existing tests; add a `drain = new AbortController()` where needed):
  - `drain raised mid-attempt lets the attempt finish and starts no second unit`: worker `P1` raises `drain.abort("handoff")` in `onSpawn`; build with `{ drain: drain.signal }`; expect status `paused` with `run.paused` reason `handoff`, `w.ids` equal `["P1"]`, and `unit.accepted` contains `P1`; the worker's own `signal` input is never aborted (record `input.signal?.aborted` at the end of the spawn and assert false).
  - `drain raised before any unit starts pauses with handoff and runs nothing`: abort the drain before calling `buildRun`; expect `paused`, `w.ids` empty, no `unit.attempt.started` events.
  - `a red attempt under drain records its Return and stops without another attempt`: worker returns red for `S1` on its first attempt and raises the drain in `onSpawn`; expect one `unit.attempt.finished` for `S1` with outcome `red`, one `unit.returned`, no second `unit.attempt.started`, pause reason `handoff`; resuming with a fresh build (no drain) runs attempt 2 of `S1` with that Return as feedback.
  - `with parallel 2 both in-flight attempts finish before the pause` (use the parallel setup from `packages/engine/test/scheduler.test.ts` or build tests if `setup()` is sequential): two independent units in flight, drain raised during the first, both accepted, then `paused` with `handoff`.
- [ ] **Step 2: Run** `bun test packages/engine/test/stop.test.ts` → the new tests fail.
- [ ] **Step 3: Implement** `stopSignal`; add `drain` to `RunPlanOptions`; make the scheduler's `stopped` return `stopSignal(opts) !== undefined`; make the `stopped()` pause helper and the post-schedule `if (opts.signal?.aborted)` check use `stopSignal(opts)` and `stopReason(stopSignal(opts))`; in `runUnit`'s attempt loop replace the `ctx.signal?.aborted` check with `stopSignal(ctx)` (reason from it). Never pass `drain` to `runAttempt` or the worker.
- [ ] **Step 4: Run** `bun test packages/engine/test/stop.test.ts packages/engine/test/engine.test.ts packages/engine/test/scheduler.test.ts packages/engine/test/resume.test.ts` and `bunx tsc -b packages/engine` → pass apart from the baseline failures.
- [ ] **Step 5: Commit** `engine: a drain signal that stops starting work without aborting workers`.

---

### Task 2: Host and handoff wiring

**Files:**
- Modify: `packages/node/src/handoff.ts` (`HandoffOptions` ~line 37; `await o.stopBuild?.()` ~line 83)
- Modify: `packages/cli/src/host.ts` (`Job` ~line 62; `startJob` ~line 232; `stopJob` ~line 256; the `handoff` case ~line 424)
- Modify: `packages/cli/src/runtime.ts` (`build` ~line 633 and its `buildRun` call ~line 653; expose the attempt timeout)
- Test: `packages/node/test/handoff.test.ts`, `packages/cli/test/nodes.test.ts`

**Interfaces:**
- Consumes: `RunPlanOptions.drain` (Task 1).
- Produces:
  - `HandoffOptions.waitMs?: number`; `HandoffOptions.stopBuild?: (waitMs?: number) => Promise<void>`; `handOff` calls `o.stopBuild?.(o.waitMs)`.
  - `Runtime.build(runId, o: { now?: boolean; signal?: AbortSignal; drain?: AbortSignal })` forwards `drain` to `buildRun`; `Runtime.attemptTimeoutMs: number` (the resolved `config.limits.attempt_timeout_ms`).
  - Host `Job` gains `drain: AbortController`; `stopJob(runId: string, reason: string, waitMs = 0): Promise<void>`: `waitMs` 0 behaves as today; above 0 it calls `job.drain.abort(reason)`, races `job.promise` against a `waitMs` timer, and only if the job is still not done when the timer fires calls `job.controller.abort(reason)`; it always awaits `job.promise` at the end.
  - The host `handoff` call takes `[runId, to, opts?: { wait?: number | "attempt" }]`: `wait: N` means `N * 1000` ms, `"attempt"` means the workspace runtime's `attemptTimeoutMs`; it passes `waitMs` to `handOff` and `stopBuild: (ms) => stopJob(runId, "handoff", ms)`; a forward to the owner node (`forward(owner, "handoff", args)`) carries the same `args` unchanged.

- [ ] **Step 1: Write failing tests.**
  - `packages/node/test/handoff.test.ts`: `waitMs reaches stopBuild` (use the `buildingOnA` setup; pass `waitMs: 1234` and record the argument `stopBuild` receives) and `without waitMs stopBuild gets undefined`.
  - `packages/cli/test/nodes.test.ts`, next to the existing handoff test (same `openHost`, `localTransport`, `held` pattern): (a) `handoff --wait lets the attempt in flight finish`: T2's worker waits 200 ms then returns its normal scripted result, ignoring `input.signal`; call `mbp.api.call("handoff", ["R5", "denver", { wait: 30 }], ws)`; assert T2 is accepted on mbp (a `unit.accepted` for T2 written by node `mbp`), no `unit.attempt.interrupted` for T2, and the run is owned by denver afterwards; (b) `a wait shorter than the attempt interrupts it`: T2's worker only returns when `input.signal` aborts; `{ wait: 1 }`; assert one `unit.attempt.interrupted` for T2 with reason `handoff` and that denver redoes T2; (c) `no wait interrupts at once` is the existing test; keep it passing unchanged.
- [ ] **Step 2: Run** `bun test packages/node/test/handoff.test.ts packages/cli/test/nodes.test.ts` → the new tests fail (baseline: nodes.test.ts may have pre-existing sandbox failures; compare).
- [ ] **Step 3: Implement** the interfaces above. The attempt timeout accessor goes where the runtime already reads `config.limits.attempt_timeout_ms` (runtime.ts ~line 953).
- [ ] **Step 4: Run** the two test files plus `bun test packages/node packages/engine/test/stop.test.ts`, and `bunx tsc -b packages/node packages/engine` → pass apart from baseline failures.
- [ ] **Step 5: Commit** `node, host: handoff can wait for in-flight attempts before interrupting`.

---

### Task 3: The `--wait` flag

**Files:**
- Create: `packages/cli/src/wait-flag.ts`
- Modify: `packages/cli/src/main.ts` (`remote().handoff` ~line 129; the `handoff` command ~line 640; where argv reaches `parseArgs` ~line 770)
- Test: `packages/cli/test/wait-flag.test.ts`

**Interfaces:**
- Consumes: the host `handoff` call shape from Task 2.
- Produces: `export function parseWaitFlag(argv: string[]): { argv: string[]; wait?: number | "attempt" }` — removes `--wait` (and its value) from `argv` and returns what it meant, or throws an `Error` whose message is the usage error:
  - `--wait` as the last token, or followed by a token starting with `-`: `"attempt"`.
  - `--wait <digits>` or `--wait=<digits>` with a value of at least 1: that number of seconds.
  - `--wait 0`, `--wait=0`, `--wait=` or `--wait=abc`: error `--wait takes a number of seconds of at least 1, or nothing to wait up to the attempt timeout`.
  - `--wait` followed by a non-numeric word (for example `--wait R1 denver`): error `--wait takes seconds, or nothing; put it after the run and node`.
  - No `--wait`: `argv` returned unchanged, `wait` undefined.
  - `remote().handoff(id: string, node: string, o?: { wait?: number | "attempt" })` calls `c("handoff", id, node, o ?? {})`.

- [ ] **Step 1: Write failing tests** in `wait-flag.test.ts`: the eight cases above as exact `parseWaitFlag` input/output pairs (for example `["handoff","R1","denver","--wait"]` → `{ argv: ["handoff","R1","denver"], wait: "attempt" }`, `["handoff","R1","denver","--wait","300"]` → seconds 300 with `300` removed from argv, `["handoff","--wait=45","R1","denver"]` → 45), asserting the exact error messages. Add one test through the real CLI entry (see how `lifecycle.test.ts` calls `heph([...])`) that `heph handoff R1 denver --wait abc` fails with the usage error and writes nothing to the ledger.
- [ ] **Step 2: Run** `bun test packages/cli/test/wait-flag.test.ts` → fails (module missing).
- [ ] **Step 3: Implement** `parseWaitFlag`; call it in `main.ts` on the raw argv before `parseArgs` and pass `wait` into the `handoff` command (put it on `Flags` as `wait?: number | "attempt"`); the command calls `rt.handoff(id, node, { ...(wait ? { wait } : {}) })`; update the usage text to `handoff <run> <node> [--wait [seconds]]` with "Move a run to another node; --wait lets attempts in flight finish first (blocks while it waits; heph watch shows progress)".
- [ ] **Step 4: Run** `bun test packages/cli/test/wait-flag.test.ts packages/cli/test/usage.test.ts` and `bunx tsc -b packages/cli` (only the unbuilt ui asset errors are baseline) → pass.
- [ ] **Step 5: Commit** `cli: heph handoff --wait`.

---

### Task 4: Cancel regression test and docs

**Files:**
- Test: `packages/cli/test/nodes.test.ts` (or `daemon.test.ts`, whichever has the `openHost` + scripted-worker setup; follow the existing handoff test there)
- Modify: `docs/NOTES.md` (the line saying cancel does not interrupt a worker in flight, ~line 269; the "Not built" line ~337; a new "Handoff wait (2026-11-06)" section before "Planner paths (2026-11-06)"), `docs/SPEC.md` (§13 Handoff, §16 CLI list), `docs/ROADMAP.md` (sub-project D)

**Interfaces:** Consumes the host API as `nodes.test.ts` uses it.

- [ ] **Step 1: Write the test** `a cancel interrupts the attempt in flight under a daemon`: a host with `daemon: true`, a worker that holds its spawn until `input.signal` aborts (as the existing handoff test's T2 does); start the run, wait until the worker is in flight, call `mbp.api.call("cancel", ["R5"], ws)`; assert the worker saw the abort, the ledger has `unit.attempt.interrupted` with reason `user` for that unit, the run's status is `failed` with reason `cancelled by user`, and no `unit.attempt.finished` exists for it. It passes by construction; keep it as a regression test and say so in the commit body.
- [ ] **Step 2: Run** it → passes (if it fails, that is a finding: stop and report).
- [ ] **Step 3: Update the docs** per the spec's section 3: correct the NOTES cancel line (daemon: cancel interrupts the attempt; no daemon: `heph cancel` only writes `run.failed` and a foreground `heph run` in another process notices at its next unit or attempt; Ctrl-C of `heph run` has no handler); move "waiting for in-flight attempts on handoff" from not built to built; add the "Handoff wait (2026-11-06)" section (drain signal, where it is checked, the `--wait` forms and the rule that a word after `--wait` is an error, the blocking behavior, what is out of scope); SPEC §13 and §16 show `--wait [seconds]` as built; ROADMAP: D built except in-process cancel and aborting gate commands on cancel.
- [ ] **Step 4: Run** `bun test packages/cli/test/nodes.test.ts packages/engine/test/stop.test.ts packages/node packages/cli/test/wait-flag.test.ts`, then compare the whole `bun test packages/cli packages/engine packages/node` failing set against a baseline checkout of the starting commit: no new failures.
- [ ] **Step 5: Commit** `docs: handoff wait as built; cancel interrupts under a daemon`.
