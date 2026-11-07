# Handoff wait: a drain signal and `heph handoff --wait` (2026-11-06)

Sub-project D of `docs/ROADMAP.md` (run control), scoped to the handoff wait policy plus a regression test and doc fixes for cancel.

## Problem

Checked in the code on 2026-11-06:

- `heph handoff` always interrupts the attempt in flight (`stopBuild` aborts the build's signal, reason `handoff`). SPEC §13 says the owner "waits for or interrupts in-flight units (configurable)"; only the interrupt half exists, so a handoff can throw away minutes of a worker's progress.
- Cancel under a daemon already interrupts an in-flight attempt (`host.ts`: `stopJob(runId, "user")` before `rt.cancel`; `packages/engine/test/stop.test.ts` covers the abort). The NOTES line saying a cancelled attempt "still finishes" predates the daemon and the abort signal and is stale. Without a daemon, `heph cancel` only writes `run.failed`; a foreground `heph run` in another process notices at its next unit or attempt.

## Decisions (2026-11-06)

- Scope: the handoff wait policy only, plus a cancel regression test and doc fixes (chosen over adding in-process cancel and over also aborting gate commands).
- Configuration: a `--wait [seconds]` flag with the default unchanged (interrupt at once), chosen over a config key and over waiting by default.
- Out of scope: cross-process cancel without a daemon and Ctrl-C handling in `heph run`; aborting gate commands on cancel (unverified); a config key for the default wait; a `heph_handoff` MCP tool (none exists); any new ledger event.

## 1. Drain in the engine

- `RunPlanOptions.drain?: AbortSignal`: a request to wind down, separate from `signal`, which interrupts workers. `drain` is never passed to a worker, so an attempt in flight keeps running.
- The scheduler's `stopped()` becomes true on `signal` or `drain`: no new unit starts; units in flight finish and are kept if accepted.
- The top of `runUnit`'s attempt loop checks `drain` next to the existing `signal` check. A unit whose attempt just went red records its Return, then stops with a `handoff` pause instead of starting another attempt; the new owner continues from that Return. A unit whose attempt went green still joins and is accepted before it stops.
- `stopReason` reads the reason from whichever signal fired, so a drained build ends `run.paused` with reason `handoff`, same shape as today.
- Builds that pass no `drain` behave exactly as now.

## 2. Handoff wiring and the CLI flag

- `HandoffOptions` (packages/node/src/handoff.ts) gains `waitMs?: number`; `stopBuild` becomes `(waitMs?: number) => Promise<void>`; `handOff` calls `stopBuild(o.waitMs)`. The step order is unchanged: the new owner's checkout is still made first, so a refused handoff never starts a wait.
- Daemon host (packages/cli/src/host.ts): each build job gets a `drain` controller beside its abort controller; `startJob` passes `drain.signal` through the runtime's `build` to the engine. `stopJob(runId, reason, waitMs = 0)`: with 0 it aborts at once, as today; above 0 it raises `drain`, races the job against a `waitMs` timer, aborts if the job is still running when the timer fires, then awaits the job. The `handoff` call takes `[runId, to, { wait?: seconds }]`; a forward to the owner node carries the options unchanged.
- CLI: `heph handoff <run> <node> [--wait [seconds]]`. No flag: unchanged. `--wait 300`: up to 300 s. Bare `--wait`: up to `limits.attempt_timeout_ms` (20 minutes by default). A non-numeric or non-positive value is a usage error. The usage text says the command blocks while it waits and that `heph watch` shows progress. `--json` output keeps its shape.
- Edge cases: no running build job means nothing to wait for and the handoff proceeds at once; a run owned by another node is forwarded to its owner with the options, but the owner's `heph peer` process has no build jobs, so the wait only takes effect when the handoff runs on the owning node (see NOTES "Handoff wait"); a job already past its last unit finishes normally and the handoff continues once it ends.

## 3. Cancel regression test, docs, rollout

- Cancel regression test (daemon level, in packages/cli/test next to the host/daemon tests): a build with an in-flight attempt receives `cancel`; the attempt is interrupted with reason `user` (not run to completion) and the run ends `failed` with "cancelled by user".
- NOTES: correct the line on interrupting a worker on `heph cancel` (with a daemon it does; without one `heph cancel` only writes `run.failed`); move "waiting for in-flight attempts on handoff" from not built to built; add a "Handoff wait (2026-11-06)" section. SPEC §13 Handoff and §16 CLI show `--wait` as built. ROADMAP: D built except in-process cancel.
- No schema or event changes, so mixed-version nodes behave as before; a node that does not know `wait` ignores the extra argument.

## Testing

- Engine (scripted worker): `drain` raised mid-attempt lets the attempt finish and be accepted and starts no second unit; a red attempt records its Return and stops without a next attempt; with `parallel` 2 both in-flight attempts finish and the build then pauses with reason `handoff`; `drain` never aborts the worker's signal.
- Host: a build with an in-flight attempt and `--wait` lets the attempt finish, then hands off; an attempt that outlasts the wait is interrupted with reason `handoff`; no flag still interrupts immediately.
- CLI: flag parsing for no flag, `--wait N`, bare `--wait`, and the error cases.
- Node: `waitMs` reaches `stopBuild`.
- The cancel regression test above.

## Not changed

The interrupt path, ledger events and projections, the order of handoff steps, and builds that pass no `drain`.
