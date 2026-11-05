# Stacking and parallel fan-out: design

Status: built 2026-11-05 (tasks 1-11; amended where the build differs, see the 2026-11-05 amendments in NOTES).
Touches: SPEC sections 2, 4, 6, 13, 16, 19 (step 3). Closes NOTES "First real runs" item 8.

## 1. Goal

1. **Stacking.** Build run B on the unmerged branch of run A, and land them in order, so the user no longer has to merge A before starting B.
2. **Parallel fan-out.** Run independent units of one plan concurrently (`limits.parallel`), instead of one at a time.

Both need one rule: a branch has a landing order relative to others, and anything based on a moving branch is rebased and re-gated. They share the rebase, re-gate and landing code, so they are one design.

Non-goals: cross-node runners and leases, multiple parents per run, optimistic (lock-free) joins, auto-rebuild when a stack conflicts, rate-limit-driven throttling beyond the resume ramp (built afterwards, SPEC section 17), stacking across workspaces.

## 2. Decisions (settled with the user)

| # | Question | Decision |
|---|---|---|
| 1 | Stacked PR shape (repo has a remote) | B's PR **bases on A's branch** (`heph/<A>`); retargeted to the real target once A merges |
| 2 | A moves after B was built | **Rebase B onto A's new tip and re-gate** at staging; conflict or red aborts and pauses B; units are not rebuilt |
| 3 | Two parallel units go green from the same tip | **Cherry-pick the late one onto the new tip; re-run its command gates if the tip moved** |
| 4 | One parallel unit escalates | **Drain**: no new starts, in-flight finish and are accepted if green, then one `run.paused` |
| 5 | `limits.parallel` default | **3** (owner decision 2026-11-05, to be tuned later; `1` is the sequential order) |

Approaches rejected: stacking as "parent branch is B's target" (B would land into A's branch, can't retarget); a separate queue entity (overkill); wave scheduling (idles on stragglers); parallelism across repos only (does not help single-repo runs).

## 3. Stacking

### 3.1 Data model

- CLI: `heph new --stack-on <run>` (`--on` already names a node). Not part of the Brief: stacking is about delivery, not the goal.
- `run.created.data.stack_on?: string` (a run id). The `runs` projection gains a `stack_on` column; `PROJECTION_VERSION` bumps so older ledgers rebuild.
- Parent eligibility, checked at `new`: same workspace, status `built` or `staged`. A parent that already landed (`finished`) means a normal run from the target, with a note. A failed or cancelled parent is refused. Chains (A <- B <- C) are allowed; each run has exactly one direct parent.
- **Per-repo base (chain walk).** A parent's branch contains its ancestors only in the repos the ancestors touched, so the base is found by walking the `stack_on` chain: in repo R, B's base is `heph/<X>` for the nearest ancestor X that is `built` or `staged`, whose `heph/<X>` exists in R and whose latest plan touches R (its `run_branch_reset` effects since its latest `run.plan_ready`: a branch left from an earlier plan is no base; amended after the final review); finished ancestors are skipped; with none, R's target (`targetBase`). An ancestor in any other status (failed, cancelled, paused, running...) makes the stack unresolvable: a fresh build pauses, `plan`/`revise` refuse, landing aborts. B's `heph/<B>` is created by the existing `run_branch_reset` effect, whose `after` is the recorded base sha. B's **fork point** in a repo is derived, never stored: the first parent of the oldest commit on `heph/<B>` carrying the trailer `Heph-Run: <B>` (attempt commits already carry it, and rebases and cherry-picks keep it). It stays correct after A is rebuilt, rebased or squash-merged, and needs no pin ref or extra effect.
- **Planning B** reads the repo map and file list from the parent's ref (`git ls-tree` on the ref), not from the working checkout. `projectFiles` takes a ref.
- **Integration gate.** `integrationGate` assembles repos B does not touch at the parent's branch (and the parent's ancestors') rather than the target, so the gate sees the whole stack.

### 3.2 Landing B (staging)

Per touched repo, in `landChangeset`:

1. Determine `onto`: the parent's current `heph/<A>` tip while A is unmerged, or the target's tip once A has landed.
2. If `onto` differs from B's fork point (derived as in 3.1), rebase with `git rebase --onto <onto> <fork point> heph/<B>`. **Never merge-base**: a squash or rebase merge of A on GitHub rewrites A's commits, so plain `rebase <target>` would replay them and conflict. `Git.rebase` gains an upstream (fork point) argument.
3. After a rebase, re-gate (project commands, then the integration gate), as today. Conflict or red: `merge.aborted` and `run.paused`; nothing pushed.
4. Push with lease and open the PR **with base `heph/<A>`** while A is unmerged (`PullRequests.open` already takes `base`).

Effect keys: rebase becomes `rebase:<repo>:<onto sha, 7 chars>` because a repo may rebase twice (against A's branch, then the target).

### 3.3 Landing order

- `mergeChangeset(B)` returns `not_ready` with the reason `waiting for <A>` unless A is `finished`. Merge approval stays a human act.
- When `checkChangeset(A)` finishes A (all PRs merged, or `approve merge A` completes), a mechanical **restack** runs on every run with `stack_on = A` that is `staged`: rebase `--onto <target tip> <fork point>`, re-gate if anything moved, push with lease, and retarget the PR base to the target. That needs a new effect `pr_retarget` (`PullRequests.setBase`, a REST `PATCH` of the pull request base; reconcile: `confirmed` when the PR's base already equals the target, else redo). Restack needs no approval, but the user must approve B's merge afterwards, since the head may have changed.
- **Recovery after a stopped restack.** A restack that hits a conflict or a red re-gate aborts the landing (`merge.aborted`, `run.paused`): B is `paused`, and `approve merge B` errors until it is staged again. The flow is: fix the cause, `heph run B` (re-lands B; landing never retargets), `heph approve merge B`, which sees a staged child whose parent is finished and that still needs a restack (staged before A landed, or a PR base not the target), restacks and retargets it and returns `restacked` **without merging**; the user reviews and runs `heph approve merge B` again to merge. The same `restacked` answer covers a restack a crash stopped partway, with B still `staged`.
- **Restack trigger and PR-base guard.** (Amended after the final review.) Whether B needs a restack is decided from the ledger, never from its PR's base, which GitHub changes by itself when it auto-deletes a merged `heph/<A>`: A's first `run.finished` is newer than B's latest `merge.staged`, in a repo with a PR that an ancestor unmerged at that staging touched. `mergeChangeset(B)` refuses then (`staged before <A> landed`), `approve merge B` restacks instead of merging, and the restack after A lands skips a B already restacked since. As an additional guard, `mergeChangeset(B)` refuses while any of B's PRs has a base other than the target, so B can never merge into `heph/<A>`. `approve merge B` merges only a head staged before its own approval event (a concurrent restack answers `restacked`). `checkChangeset(B)` records a PR a human merged into `heph/<A>`, or before A landed, as half-landed, never finished. Opening a PR on `heph/<A>` is refused for a remote repo until A is `staged` (its branch is on the remote).
- **Local-only repos:** B stages as a ref only. `approve merge A` fast-forwards the target; B's branch then descends from it (or is rebased `--onto` if A's tip changed), and `approve merge B` fast-forwards in turn.
- **Parent cancelled or failed after B was built:** B is blocked. `heph status B` says `stacked on <A> (failed)`; B cannot stage. Rebuilding is the only way out in this version.
- **Parent revised and rebuilt** after B was built: B's fork point is still derivable from its own commits, so staging rebases B `--onto` the parent's new tip. If A's new content conflicts, B pauses with the files.

### 3.4 Surfaces

- Built: `heph status` prints `stacked on <A> (<A's status>)` (and the in-flight attempts when more than one runs), `heph explain` marks the `run created` line, and `heph watch` (and MCP `heph_watch`) ends B with `waiting for <A>` when only the parent is missing.
- The Claude Code skill and the Codex copy (kept identical by a test) gain a short stacking section.

## 4. Parallel fan-out

### 4.1 Scheduler

`build()`'s `for (const id of order.order)` loop becomes a ready-set loop over a pool of `limits.parallel` slots (`EngineConfig.parallel`, default 1; with 1 it is today's sequential behaviour, same order). A unit is **ready** only when all hold:

1. Every derived-edge predecessor is accepted.
2. **`tests_passable` holds over the accepted set.** Every criterion checked by an accepted `test` task is covered by an accepted non-test task of any project (the same count the plan gate makes), or by this unit. The `tests` gate runs the whole project suite, so the plan gate's sequential-order guarantee has to hold dynamically over what is actually accepted. The check reuses the plan gate's logic from `@hephaestus/core` (extracted into a shared function, not duplicated).
3. Its scope (task scope plus `hint --scope` additions) does not overlap an in-flight unit's scope in the same repo, compared repo-relative the way the plan gate does. Widening a scope can break the plan-time disjointness guarantee, so it is checked at start.
4. **Within a project a test unit is a barrier at its place in canonical order** (added 2026-11-05 after a live run, revised the same day after review). Each unit's `tests` gate, and a join's re-gate, runs the project's whole suite, so a new red test from one chain fails every other unit of the project. A `test` unit of project P is ready only when every unit of P ordered before it is accepted and no other unit of P is in flight or was just picked; a non-test unit of P is not ready while a test unit of P is in flight or picked, or while a test unit of P ordered before it is not yet accepted. Non-test units of P between two of its test units run in parallel under rules 1-3, and units of different projects never hold each other back this way. Each project therefore sees its units in the sequential order the plan gate's `tests_passable` simulates, and with `parallel` 1 the order is exactly that order. Two independent test-to-implement chains in one project run T1, T2, T3, T4. A first version held a test unit back on any open criterion (one an accepted test checks that remaining work covers), which deadlocked gate-accepted plans such as two locked tests with one shared implementation; holding it only when a remaining satisfier does not depend on it still broke the sequential order (an implementation could run before an earlier, unconsumed test of its criterion, which would then already pass).
5. A slot is free.

Locked paths are unchanged: they come from accepted test tasks that precede the unit in the derived graph.

### 4.2 Pause, escalation, cancel

- The first escalation, `blocked`, or rate limit sets a *draining* flag: no new units start, in-flight units finish their attempts and are accepted if green (their work is kept).
- When the pool is empty the scheduler writes **one** `run.paused`. Today `runUnit` writes `run.paused` itself; that moves to the scheduler. `unit.escalated` stays atomic with the attempt verdict (crash consistency, NOTES 2.7 item 2), so only the run-level pause moves.
- Reason precedence for the single pause: stop or handoff (signal), then a unit waiting for the user, then rate limit (with the latest `retry_after`).
- `cancelled()` and the `AbortSignal` reach every in-flight worker; handoff interrupts all attempts (each marked interrupted, reason `handoff`).

### 4.3 Joining the run branch

`run_branch_advance` today uses `updateRef(branch, sha, tip)` where the attempt branched from `tip`. With concurrency the tip can move while an attempt runs.

- Advances are serialized per repo under a **join lock**.
- Run-branch tip equals the attempt's start tip: fast-forward, exactly as now.
- Tip moved: replay the attempt commit onto the new tip (`git cherry-pick`) in a temp worktree. Scopes are disjoint, so a conflict is not expected; if one happens it is recorded as a failed `join` gate (a normal Return; the attempt counts). Then **re-run tests, typecheck and lint on the combined tree** (their `gate.result` events carry the same unit and attempt, written before `unit.attempt.finished`). Red: normal Return. Green: `run_branch_advance` with `before` = the current tip and `after` = the replayed sha.
- The replay is attempt-local work, not an effect (SPEC section 13); the effect, its reconcile rules and the resume path are unchanged. Chaos must cover kills inside the join.
- Cost: a late unit pays one extra gate run, and joins serialize while the lock is held during a re-gate. Known and accepted; optimistic joining is a non-goal.
- `Runner` gains a step for the join re-gate (`rejoin`), since only the runner holds sandboxes and the gate list.

### 4.4 Worker isolation (risk, spike first)

NOTES (2.8 findings) records that **OMP sessions cannot start concurrently in one process** ("Agent Main was replaced"). The scheduler design is independent of the answer, but the plan's first step is a spike:

- If the failure is a start-time race, serialize session creation inside `createOmpWorker` and keep the in-process runner.
- If concurrent sessions are fundamentally unsupported in one process, add a **subprocess runner**: one `heph worker` process per attempt, behind the existing `Runner` interface. It is also the first piece of cross-node runners (SPEC section 7), so the work is not wasted.

Whichever holds, `limits.parallel` defaults to 3 (owner decision 2026-11-05, to be tuned later).

### 4.5 Ledger and surfaces

- No new event types for fan-out. Events for different units interleave; every per-unit projection and `unitHistory` already key by unit, and `resume()` already interrupts every open attempt.
- Ledger additions overall: `stack_on` on `run.created`; the `pr_retarget` effect kind. `EffectKind` and its zod enum gain it; unknown-type behaviour (NOTES ledger item 6) keeps older nodes readable.
- `heph run`/`watch` already print unit ids per line, so interleaved units stay readable. `heph status` shows what is in flight.

## 5. Where the changes land

Kept to branch, landing and scheduling regions:

| Area | Change |
|---|---|
| `packages/engine/src/engine.ts` | `build()` scheduler loop; per-repo base resolution; join call in `runUnit`; the single `run.paused` out of `runUnit` |
| `land.ts` | `onto` selection, `--onto` rebase, `pr_retarget`, restack, order check in `mergeChangeset` |
| `git.ts` | `rebase(path, branch, onto, upstream?)`, `cherryPick`, `ls-tree` at a ref |
| `integration.ts`, `engine.ts` `integrationGate` | stack-aware refs |
| `runner.ts` | `rejoin`; maybe a subprocess runner (4.4) |
| `prs.ts` | `setBase` (REST) |
| `packages/core` | shared `tests_passable` over an accepted set; `stack_on` in run schemas |
| `packages/ledger` | `stack_on`, `runs` column, `pr_retarget`, projection version |
| `packages/cli` | `--stack-on`, status/watch/explain lines, `limits.parallel` config, skill text |

**Coordination:** the stall-detect session edits the `runUnit` escalation region. The drain refactor moves `run.paused` out of that region, so the two changes overlap; flag it to them before implementation starts.

## 6. Testing

- Unit tests: ready-set predicate (each of the four rules); join with and without a moved tip; stack base resolution per repo; `--onto` rebase after a squash-style rewrite of the parent.
- Stacking end-to-end on temp repos with a fake PR client: A staged, B staged with base `heph/<A>`; `approve merge B` before A is refused; A merged, B restacked and retargeted; a chain of three; a parent that moved; a local-only repo.
- Chaos: the existing kill-at-every-effect test extended to `parallel=2` on a diamond plan (accepted units, commit counts, no pending effects, no leftover worktrees), and to the join and restack effects. `chaos-smoke.ts` with real SIGKILLs on both.
- Mutation checks, as for 2.7: accept a joined unit without re-gating when the tip moved; land B before A.
- A live run on LegendsAO (a stack of two runs; a plan with two independent units) before `parallel` defaults change (done; see NOTES, 2026-11-05).

## 7. Open items

- Whether the 4.4 spike lands on the in-process or the subprocess runner (decides plan size).
- Restack as a daemon job versus run on `heph merge status` / `approve merge`; the plan should pick whichever reuses the daemon's existing scheduling.
- Optimistic joins stay later work (see NOTES, "Not built"). Rate-limit throttling was built afterwards in its minimal form: a build resuming from a rate limit starts at half its parallelism and ramps back up (SPEC section 17); budget tracking and rerouting are later work.
- Built afterwards (NOTES, "Gaps closed"): the engine's `autoMerge` restacks the run's staged children like `approve merge`; joined commits are pinned under `refs/heph/join/` until accepted.
