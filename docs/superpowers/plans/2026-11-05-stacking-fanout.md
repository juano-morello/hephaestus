# Stacking and Parallel Fan-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a run on another run's unmerged branch and land them in order (stacking), and run independent units of a plan concurrently (fan-out).

**Architecture:** Fan-out replaces `build()`'s sequential loop with a ready-set scheduler (a pure predicate in core, a pool and drain in the engine) and joins accepted attempts onto the run branch under a per-repo lock, replaying and re-gating when the tip moved. Stacking adds `stack_on` to a run; the engine resolves each repo's base from the parent's branch, and landing rebases `--onto` a fork point derived from the run's own commit trailers, opens PRs based on the parent's branch, and restacks children when the parent lands.

**Tech Stack:** TypeScript on Bun, zod, bun:sqlite, git CLI, `gh` CLI. Tests: `bun test`. Checks: `bun run typecheck`, `bun run lint`.

**Spec:** `docs/superpowers/specs/2026-11-05-stacking-fanout-design.md` (read it first; SPEC.md sections 2, 4, 6, 13, 16 and NOTES.md "First real runs" item 8 give the background).

## Global Constraints

- **Commits:** NEVER add `Co-Authored-By` or any AI/Claude attribution to commits or PR text (repo rule; overrides any default).
- `limits.parallel` defaults to **1**; with 1, behaviour and unit order are exactly today's.
- The CLI flag is `--stack-on <run>` (`--on` already names a node). Stacking is not part of the Brief.
- Merge approval stays human: `heph approve merge` is never run by the engine; restack is mechanical and needs no approval.
- Rebase onto a moved parent uses `git rebase --onto <onto> <fork point> <branch>`, never merge-base.
- A repo's fork point for run B is derived: the first parent of the oldest commit on `heph/<B>` whose message has the trailer `Heph-Run: <B>`. No pin ref is stored.
- Rebase effect key is `rebase:<repo>:<onto sha, first 7 chars>`.
- No new ledger event types. New: `stack_on` in `run.created` data, `stack_on` on the `runs` projection (`PROJECTION_VERSION` 3 -> 4), effect kind `pr_retarget`.
- Process spawning stays in `packages/sandbox`; `bun:sqlite` stays in `packages/ledger/src/db.ts`.
- Keep edits to branch/landing/scheduling regions of `engine.ts`; another session edits the escalation region of `runUnit` (stall detection). Do not reflow unrelated code.
- Every task ends with `bun run typecheck && bun run lint && bun test <the task's test files>` green.

## Review Focus

1. A plan with one unit (or a pure chain) and `parallel: 4` behaves exactly like sequential: same order, same events. Pinned in Task 4.
2. A `hint --scope` widening that overlaps an in-flight unit makes the unit wait, not fail or run concurrently. Pinned in Task 2.
3. Parent merged on GitHub by squash (commits rewritten): the child restacks with no conflict and the right base. Pinned in Task 9.
4. Parent touched repos the child does not (and the reverse): per-repo base and integration refs are right. Pinned in Task 8.
5. Two children stacked on the same parent both restack after it lands. Pinned in Task 10.
6. A handoff/cancel while a join re-gate is running leaves no worktree or pending effect. Pinned in Task 5.

## File structure

- Create `packages/core/src/graph/ready.ts`: pure ready-set predicate (`readyUnits`).
- Create `packages/engine/src/scheduler.ts`: the pool/drain loop, no git or ledger knowledge beyond callbacks.
- Create `packages/engine/src/join.ts`: per-repo join lock and the join step.
- Create `packages/engine/src/stack.ts`: base resolution, fork point, `onto` selection, restack.
- Modify `packages/engine/src/{engine,land,git,runner,files,prs,config}.ts`, `packages/core/src/{gates/plan,schemas/config,index}.ts`, `packages/ledger/src/{events,projections/*,ledger}.ts`, `packages/cli/src/{runtime,main,output,config}.ts`, the skill files, `docs/SPEC.md`, `docs/NOTES.md`.

---

### Task 1: Spike: can OMP run concurrent sessions in one process?

**Files:**
- Create: `packages/workers/scripts/concurrency-spike.ts` (throwaway; delete after the decision is recorded)
- Modify: `docs/NOTES.md` (new "Fan-out spike" subsection under "Spec interpretations" or a new dated section)

**Interfaces:**
- Produces: a recorded decision, one of `in-process (serialize session start)` or `subprocess runner`, which fixes whether Task 5b exists.

- [ ] **Step 1: Write the script.** It builds the existing OMP worker (`createOmpWorker` in `packages/workers`) and calls `spawn` twice concurrently (`Promise.all`) on two temp dirs with a trivial brief on the cheapest model, then repeats with the second `spawn` started after the first session finished creating but before it finished running (staggered by 2 s). It prints, per call, `exit`, whether the transcript is non-empty, and any "replaced" error.
- [ ] **Step 2: Run it** (`bun packages/workers/scripts/concurrency-spike.ts`; needs OMP login, so ask the user to run it if the sandbox blocks it). Expected: either both calls succeed (staggered or not), or the error `Agent Main was replaced` appears.
- [ ] **Step 3: Decide and record.** If the staggered case succeeds, record "serialize session creation in `createOmpWorker` with a promise chain; keep the in-process runner" and implement that one-line serialization now (test: two concurrent `spawn`s with a fake session factory both complete). If both fail, record "subprocess runner required" and mark Task 5b as in scope.
- [ ] **Step 4: Delete the script, commit** (`docs: OMP concurrency spike result` plus the serialization change if any).

---

### Task 2: `limits.parallel` config and the ready-set predicate

**Files:**
- Modify: `packages/core/src/schemas/config.ts` (`Limits`, defaults at ~line 184), `packages/engine/src/config.ts` (`EngineConfig`), `packages/cli/src/runtime.ts` (`toEngineConfig`)
- Create: `packages/core/src/graph/ready.ts`; modify `packages/core/src/index.ts` (export), `packages/core/src/gates/plan.ts` (extract shared helpers)
- Test: `packages/core/test/ready.test.ts`, `packages/core/test/config.test.ts`

**Interfaces:**
- Produces:
  - `Limits.parallel: number` (int, positive, default 1); `EngineConfig.parallel: number`.
  - In `ready.ts`:
    - `export type SchedState = { accepted: ReadonlySet<string>; inFlight: ReadonlySet<string>; scopeOf: (id: string) => string[] }`
    - `export function readyUnits(plan: Plan, workspace: Workspace, state: SchedState, free: number): string[]`
  - In `plan.ts`, extracted and exported for reuse: `testsPassableAfter(tasks: Task[], accepted: ReadonlySet<string>, candidate: Task): boolean` (rule 2 of the spec, 4.1) and `scopesOverlap(a: string[], b: string[], repoRootA: string, repoRootB: string): boolean` (the glob/path comparison `parallelScopesDisjoint` already does, repo-relative).
- `readyUnits` returns at most `free` ids, in canonical order (topological, plan order on ties), none already accepted or in flight.

- [ ] **Step 1: Write failing tests** in `ready.test.ts` (plans built with helpers from `packages/core/test/helpers.ts`):
  - `readyUnits_respects_edges`: T2 consumes T1's artifact; with nothing accepted only `["T1"]`; after T1 accepted, `["T2"]`.
  - `readyUnits_caps_at_free`: three independent tasks, `free = 2` returns the first two in plan order.
  - `readyUnits_waits_for_satisfier_of_accepted_test`: project P has test task T1 (covers AC1), independent non-test tasks T2 (covers AC1) and T3 (covers AC2, no edge to T2). With T1 accepted and nothing else, `readyUnits` returns `["T2"]` only (T3 would run against a suite checking AC1 that nothing has satisfied).
  - `readyUnits_skips_overlapping_scope_with_in_flight`: T2 in flight with scope `src/**`; T3 (independent, same repo) with `scopeOf(T3) = ["src/a.go"]` is not returned; with `scopeOf(T3) = ["docs/x.md"]` it is.
  - `readyUnits_other_repo_never_overlaps`: same scope globs in different repos do not block.
  - In `config.test.ts`: `limits.parallel` defaults to 1 and rejects 0.
- [ ] **Step 2: Run** `bun test packages/core/test/ready.test.ts` and confirm failures (functions missing).
- [ ] **Step 3: Implement** the interfaces above. `readyUnits` reuses `deriveEdges`, `topoOrder`, `testsPassableAfter` and `scopesOverlap`; refactor `testsPassable` and `parallelScopesDisjoint` to call the extracted helpers, so existing plan-gate tests keep passing unchanged. Wire `Limits.parallel` through `toEngineConfig` (`parallel: config.limits.parallel`) and into `configHash` input automatically via `EngineConfig`.
- [ ] **Step 4: Run** the full core and cli config tests: `bun test packages/core packages/cli/test/config.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(core): ready-set predicate and limits.parallel`).

---

### Task 3: Git primitives

**Files:**
- Modify: `packages/engine/src/git.ts`, `packages/engine/src/files.ts`
- Test: `packages/engine/test/git.test.ts`, `packages/engine/test/files.test.ts`

**Interfaces:**
- Produces on `Git`:
  - `rebase(path: string, branch: string, onto: string, upstream?: string): Promise<RebaseResult>`: with `upstream`, runs `git rebase --onto <onto> <upstream>`.
  - `cherryPickIn(worktree: string, commit: string): Promise<{ ok: true; sha: string } | { ok: false; conflicts: string[] }>`: cherry-picks `commit` onto the worktree's HEAD, aborts on conflict (worktree left clean).
  - `isAncestor(a: string, b: string): Promise<boolean>`.
  - `lsTree(ref: string): Promise<string[]>`: files at a ref.
  - `forkPoint(branch: string, runId: string): Promise<string | undefined>`: the derivation in Global Constraints (oldest commit with trailer `Heph-Run: <runId>`, its first parent; `undefined` if none).
- `projectFiles(workspace: Workspace, workspaceRoot: string, refs?: Record<string, string>)`: when `refs[repo]` is given, files come from `lsTree(refs[repo])` instead of the checkout.

- [ ] **Step 1: Write failing tests.**
  - `rebase_onto_with_upstream_skips_old_base`: repo with main, commit P on a branch `parent`, branch `child` from `parent` with commit C, then rewrite `parent` (reset to a different commit P' with the same content, as a squash does) and `rebase(path, "child", P', P)` returns ok with only C replayed.
  - `rebase_onto_conflict_leaves_branch_untouched` (keep the existing conflict test style).
  - `cherryPickIn_replays_and_reports_conflict`: clean case returns a sha with the same tree delta; conflicting case returns the conflicting file and leaves `git status` clean.
  - `forkPoint_finds_base_after_rebase`: commits with trailers on a branch, rebase them elsewhere, `forkPoint` equals the new base; none returns `undefined`.
  - `lsTree_lists_files_at_ref`; `isAncestor_true_false`.
  - `files.test.ts`: `projectFiles` with `refs` returns the ref's files, ignoring working-tree edits.
- [ ] **Step 2: Run** `bun test packages/engine/test/git.test.ts packages/engine/test/files.test.ts`; expect failures.
- [ ] **Step 3: Implement** with plain git commands in `git.ts` (`cherry-pick`, `rev-list --reverse --grep='^Heph-Run: <id>$' -E`, `ls-tree -r --name-only`, `merge-base --is-ancestor`); `forkPoint` takes the first rev-list line then `rev-parse <sha>^`.
- [ ] **Step 4: Run** the same tests; expect PASS.
- [ ] **Step 5: Commit** (`feat(engine): git primitives for cherry-pick, --onto rebase and fork points`).

---

### Task 4: Scheduler with pool and drain (parallel stays correct at 1)

**Files:**
- Create: `packages/engine/src/scheduler.ts`
- Modify: `packages/engine/src/engine.ts` (`build()` loop at ~441-475, `runUnit` pause writes)
- Test: `packages/engine/test/scheduler.test.ts`, existing `engine.test.ts`, `resume.test.ts`, `stop.test.ts`, `chaos.test.ts` must still pass unchanged

**Interfaces:**
- Consumes: `readyUnits` (Task 2).
- Produces:
  - `export type UnitResult = { status: "accepted"; files: string[] } | { status: "paused"; reason: "rate_limit" | "handoff" | "user"; detail: string; retryAfter?: string } | { status: "cancelled"; reason: string }` (replaces the engine's private `UnitResult`; `detail` is what `build()` reports today, e.g. `T2: blocked: ...`).
  - `export async function schedule(o: { plan: Plan; workspace: Workspace; parallel: number; accepted: Map<string, string[]>; scopeOf(id: string): string[]; start(id: string): Promise<UnitResult>; stopped(): boolean }): Promise<{ kind: "done" } | { kind: "paused"; reason: "rate_limit" | "handoff" | "user"; detail: string; retryAfter?: string } | { kind: "cancelled"; reason: string }>`.
- Behaviour: loop `readyUnits(..., free = parallel - inFlight)` and `start` each; on any non-accepted result set draining (start nothing new), await the rest, record accepted ones, then return one outcome. Pause reason precedence: `handoff`, then `user`, then `rate_limit` (with the latest `retryAfter`); `cancelled` wins over all. `stopped()` true also drains. `build()` writes the single `run.paused` (reason + `retry_after`) from the returned outcome; `runUnit` no longer appends `run.paused` (it still appends `unit.escalated` and `unit.attempt.interrupted` atomically with its verdict exactly as now).

- [ ] **Step 1: Write failing tests** in `scheduler.test.ts` with a fake `start` (controlled promises):
  - `parallel_1_runs_in_canonical_order_one_at_a_time` (never two in flight; order equals `topoOrder`).
  - `parallel_2_runs_independent_units_together` (both in flight before either resolves) and `dependent_unit_waits`.
  - `drain_on_escalation`: T1 resolves paused/user while T2 in flight; T3 is never started; T2's result (accepted) is recorded in `accepted`; outcome is paused/user.
  - `pause_reason_precedence`: rate_limit + user -> user; handoff + user -> handoff; the latest `retryAfter` kept for rate_limit-only.
  - `cancelled_wins`.
  - Engine-level (in `engine.test.ts` style, parallel 1): a chain plan produces the same ledger event type sequence as before the change; one `run.paused` per pause.
- [ ] **Step 2: Run** `bun test packages/engine/test/scheduler.test.ts`; expect failures.
- [ ] **Step 3: Implement** `schedule`; replace the `for` loop in `build()` with it (`start` = the existing per-unit body: locked paths, cancel/abort checks, `runUnit`); `scopeOf(id)` comes from `humanInput(ctx, task).scope`; add `parallel` from `opts.config.parallel`. Remove `run.paused` appends from `runUnit` (three places: abort at attempt start, interrupted, blocked, escalation) and from the `stopped()` helper's duplicates, writing them once in `build()`. Keep `unit.escalated` events where they are.
- [ ] **Step 4: Run** `bun test packages/engine`. Expected: PASS, including unchanged resume, stop and chaos tests (parallel defaults to 1). Note in the commit that `parallel > 1` is not safe until Task 5.
- [ ] **Step 5: Commit** (`feat(engine): ready-set scheduler with drain`).

---

### Task 5: Join: per-repo lock, replay and re-gate

**Files:**
- Create: `packages/engine/src/join.ts`
- Modify: `packages/engine/src/runner.ts` (`Runner.rejoin`, `localRunner`), `packages/engine/src/engine.ts` (`runUnit` green branch, ~698-718)
- Test: `packages/engine/test/join.test.ts`

**Interfaces:**
- Consumes: `Git.cherryPickIn`, `Git.worktreeAddDetached` (Task 3).
- Produces:
  - `join.ts`: `export function joinLocks(): <T>(repo: string, fn: () => Promise<T>) => Promise<T>` (a per-repo promise-chain mutex).
  - `Runner.rejoin(req: RejoinRequest): Promise<RejoinResult>` with
    `RejoinRequest = { runId: string; task: Task; attempt: number; repoDir: string; projectPath: string; project: ContextPack["project"]; locked: string[]; commit: string; tip: string; worker: WorkerResult; signal?: AbortSignal }` and
    `RejoinResult = { kind: "joined"; sha: string; gates: GateResult[] } | { kind: "red"; gates: GateResult[] }`.
    `rejoin` opens a detached worktree at `tip`, `cherryPickIn(commit)`; on conflict returns `red` with one failing gate `join` (evidence: the conflicting files); else runs only the command gates (`tests`, `typecheck`, `lint`) on the combined tree in a fresh gate sandbox; always removes the worktree.
  - In `runUnit`, green outcome: inside `lock(repo)`, read the current run-branch tip; if it equals the attempt's `tip`, advance exactly as today; else call `runner.rejoin`, append its gates to the attempt's `finished` events (same unit and attempt), and on `red` go down the existing red path (Return, counted); on `joined` advance with `before` = current tip, `after` = joined sha, `unit.accepted` follows as now.

- [ ] **Step 1: Write failing tests** (`join.test.ts`, real temp repo, scripted worker and gates like `engine.test.ts`; parallel 2):
  - `two_independent_units_both_accepted`: a plan with two independent units in one repo with disjoint scopes; both end accepted, the run branch contains both changes, history is linear, and the late unit has extra `gate.result` events (tests/typecheck/lint) from the join.
  - `join_not_regated_when_tip_unchanged`: sequential plan (parallel 1) produces no extra gate results.
  - `join_conflict_is_a_red_join_gate`: force overlapping edits (bypassing diff_scope with a gate list without it) and assert a `join` fail result, a `unit.returned`, and that the attempt counts.
  - `join_regate_red_returns_the_unit`: the combined-tree `tests` gate fails; unit gets a Return.
  - `lock_serializes_advances`: two joins never overlap (instrumented sandbox).
  - `abort_during_join_leaves_nothing` (Review Focus 6): abort the signal while the re-gate runs; assert no leftover worktrees under `worktreesDir/<run>`, no pending effects (`reconcile` finds none), run paused.
- [ ] **Step 2: Run** `bun test packages/engine/test/join.test.ts`; expect failures.
- [ ] **Step 3: Implement** as described. The replay is attempt-local (not an effect); the existing `run_branch_advance` effect and its reconcile are unchanged. Create `joinLocks()` once per `build()` and put it on `Ctx`.
- [ ] **Step 4: Run** `bun test packages/engine`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(engine): join accepted attempts under a per-repo lock, replay and re-gate`).

#### Task 5b (only if Task 1 chose "subprocess runner"): subprocess runner

**Files:** Create `packages/engine/src/subprocess-runner.ts`, a `heph worker` entry in `packages/cli/src/main.ts`; Test `packages/engine/test/subprocess-runner.test.ts`.
**Interfaces:** Produces `subprocessRunner(o: { command: string[]; worktreesDir: string; ... }): Runner` implementing `runAttempt` and `rejoin` by running one child per call that reads an `AttemptRequest`/`RejoinRequest` JSON on stdin and writes the result JSON on stdout (blobs as strings). The child runs `localRunner` logic with the real worker.
- [ ] Steps: failing test that two concurrent `runAttempt`s through a fake child command both finish and a killed child yields an interrupted result (reason `crash`); implement; wire `limits.parallel > 1` in the CLI runtime to choose it; run `bun test packages/engine packages/cli`; commit.

---

### Task 6: Chaos and mutation checks for fan-out

**Files:**
- Modify: `packages/engine/test/chaos.test.ts`, `packages/engine/scripts/chaos-smoke.ts`
- Test: same

**Interfaces:**
- Consumes: scheduler and join (Tasks 4 and 5).

- [ ] **Step 1: Extend the chaos test** with a diamond plan (T1 -> T2, T3 -> T4; T2 and T3 independent, same repo) run at `parallel: 2`, killing at every ledger write and effect point exactly as the existing test does, then resuming. Assertions are the existing ones: same trees, same commit counts, one green attempt per unit, no pending effects, no leftover worktrees. Because scheduling order may vary, compare trees and per-unit accepted counts, not event order.
- [ ] **Step 2: Run** `bun test packages/engine/test/chaos.test.ts`; expect PASS (fix engine bugs it finds; each fix gets its own commit with a focused test).
- [ ] **Step 3: Mutation checks** (do each, confirm a test fails, revert): skip the re-gate when the tip moved; let `schedule` start a unit while draining; accept a joined unit without advancing under the lock. Record the three results in the commit message body.
- [ ] **Step 4: Extend `chaos-smoke.ts`** (real SIGKILLs) with `--parallel 2`; run it with seed 7 (`bun packages/engine/scripts/chaos-smoke.ts`), expected `N of N the same`.
- [ ] **Step 5: Commit** (`test(engine): chaos and mutation checks for parallel fan-out`).

---

### Task 7: Ledger support for stacking

**Files:**
- Modify: `packages/ledger/src/events.ts` (`run.created` data, `EffectKind`), `packages/ledger/src/projections/schema.ts` (`PROJECTION_VERSION` = 4, `runs.stack_on`), `packages/ledger/src/projections/apply.ts`, `packages/ledger/src/ledger.ts`, `packages/ledger/src/store.ts` as needed
- Test: `packages/ledger/test/events.test.ts`, `projections.test.ts`, `store.test.ts`

**Interfaces:**
- Produces: `run.created.data.stack_on?: string` (an `Id`); `EffectKind` includes `"pr_retarget"`; the run row gains `stack_on: string | null`; `ledger.stackedOn(runId: string): string[]` returns run ids whose `stack_on` is `runId`, oldest first.

- [ ] **Step 1: Write failing tests:** `run.created` accepts and round-trips `stack_on`; an older ledger (version 3) is rebuilt on open and the column exists; `stackedOn` returns children in creation order and `[]` for none; `pr_retarget` is a valid `effect.intended` kind; unknown-type reads still work.
- [ ] **Step 2: Run** `bun test packages/ledger`; expect failures.
- [ ] **Step 3: Implement.** Follow the projection-version pattern already in `projections/index.ts` (drop and rebuild on mismatch).
- [ ] **Step 4: Run** `bun test packages/ledger`; expect PASS.
- [ ] **Step 5: Commit** (`feat(ledger): stack_on and the pr_retarget effect`).

---

### Task 8: Stacked builds: base resolution and `heph new --stack-on`

**Files:**
- Create: `packages/engine/src/stack.ts`
- Modify: `packages/engine/src/engine.ts` (`RunPlanOptions`, `build()` reset block ~395-414, `integrationGate`), `packages/engine/src/index.ts`, `packages/cli/src/runtime.ts` (`newRun`, planning file list at ~297), `packages/cli/src/main.ts` (`new --stack-on`), `packages/cli/src/output.ts`
- Test: `packages/engine/test/stack.test.ts`, `packages/cli/test/lifecycle.test.ts`

**Interfaces:**
- Produces:
  - `RunPlanOptions.stackOn?: string` (parent run id).
  - `stack.ts`: `export async function baseRef(o: { git: Git; repo: string; stackOn?: string; parentStatus?: string; target: string }): Promise<string>`: `heph/<stackOn>` if `stackOn` is set, `parentStatus` is `built` or `staged`, and that branch exists in the repo (`git.refSha`); otherwise `targetBase(git, target)`.
  - `export function stackRefs(...)`: the refs map for `integrationGate` for repos the run does not touch: the parent's branch (found through the same rule, walking up `stack_on` chains is unnecessary because each parent branch already contains its ancestors) else the target.
  - `Runtime.newRun(brief, o: { runId?: string; stackOn?: string })` validates the parent (exists, same workspace name, owned by this node, status `built` or `staged`; `finished` -> proceed as a normal run and say so in the result; `failed`/missing/other owner -> error text naming the reason), writes `stack_on` in `run.created`, and plans against file lists read from the base refs (`projectFiles(workspace, root, refs)`).
- CLI: `heph new --brief f --stack-on <run>`; the run's `status` JSON gains `stack_on`. `--stack-on` forces placement on the parent's owner.

- [ ] **Step 1: Write failing tests:**
  - `baseRef_uses_parent_branch_when_built`, `baseRef_falls_back_to_target_when_parent_untouched_repo` (parent branch missing in that repo), `baseRef_target_when_parent_finished`.
  - Engine: build B with `stackOn: A` after building A in `threeRepos`-style fixture (parent touches `proto` and `server`; child touches `server` only): B's `heph/B` starts at A's `heph/A` tip in `server`; the integration gate (scripted) sees `proto` at `heph/A`, `web` at its target (Review Focus 4). Also the reverse: child touches `web` only, parent touched `server`: child's `web` base is target, integration sees `server` at `heph/A`.
  - `chain_of_three_bases_on_direct_parent`.
  - CLI lifecycle: `new --stack-on <A>` records `stack_on`, refuses a failed parent, and the planner call receives file lists that include a file only present on `heph/A`.
- [ ] **Step 2: Run** `bun test packages/engine/test/stack.test.ts packages/cli/test/lifecycle.test.ts`; expect failures.
- [ ] **Step 3: Implement** with the interfaces above. In `build()` the fresh-build reset uses `baseRef` instead of `targetBase(...)` directly; the recorded `after` in `run_branch_reset` is that base sha (unchanged shape).
- [ ] **Step 4: Run** `bun test packages/engine packages/cli`; expect PASS.
- [ ] **Step 5: Commit** (`feat: build a run on another run's branch (heph new --stack-on)`).

---

### Task 9: Landing a stacked run: `--onto`, PR base, order

**Files:**
- Modify: `packages/engine/src/land.ts` (`landChangeset` rebase block ~118-159, PR open ~166-223, `mergeChangeset`), `packages/engine/src/prs.ts` (`PullRequests.setBase`, gh implementation), `packages/engine/src/stack.ts` (`ontoFor`)
- Test: `packages/engine/test/land.test.ts`, `packages/engine/test/stack.test.ts`

**Interfaces:**
- Consumes: `forkPoint`, `rebase(..., upstream)`, `isAncestor` (Task 3); `stackedOn` and `stack_on` (Task 7).
- Produces:
  - `LandOptions.stackOn?: string` and `LandOptions.parentStatus?: "built" | "staged" | "finished"` (set by the runtime from the ledger).
  - `stack.ts`: `export async function ontoFor(o: { git: Git; repo: string; runId: string; stackOn?: string; parentStatus?: string; targetTip: string }): Promise<{ onto: string; base: string }>` where `base` is the PR base branch name: `heph/<stackOn>` while the parent is unmerged (`built`/`staged`) and its branch exists in the repo, else the target branch; `onto` is that branch's tip.
  - `PullRequests.setBase(p: { repoDir: string; url: string; base: string }): Promise<void>` (gh: REST `PATCH repos/<owner>/<repo>/pulls/<n>` with `base`, like `edit`).
  - `landChangeset`: per repo, `{onto, base} = ontoFor(...)`; if `forkPoint(branch, runId)` differs from `onto` and `onto` is not already an ancestor-match, rebase with `upstream = forkPoint` under effect key `rebase:<repo>:<onto7>`; re-gate rules unchanged (after any rebase, including one made earlier in a stopped landing); PR `base` is `base`. A run that is not stacked behaves exactly as today.
  - `mergeChangeset`: when `parentStatus` is `built` or `staged`, return `{ status: "not_ready", reasons: ["waiting for <parent>"] }` before touching anything.

- [ ] **Step 1: Write failing tests** (fake `PullRequests` recording calls; temp repos):
  - `stacked_pr_opens_with_parent_branch_as_base`.
  - `parent_moved_rebases_child_onto_new_parent_tip_and_regates` (conflict case aborts with `merge.aborted` and files, nothing pushed).
  - `parent_squash_merged_restacks_without_conflict` (Review Focus 3): parent branch content squashed into main as a new commit; child `ontoFor` returns the target; `rebase --onto main <forkPoint>` yields a branch whose only extra commits are the child's; PR base is the target.
  - `merge_before_parent_is_not_ready`.
  - `local_only_stack`: no remote; A staged, `mergeChangeset(A)` fast-forwards main, then B stages as a ref and `mergeChangeset(B)` fast-forwards after a rebase `--onto`.
  - `rebase_effect_key_includes_onto`: two landings against different `onto` write distinct keys; reconcile (chaos hook at `before:`/`after:` the rebase key) finishes either.
  - `unstacked_landing_unchanged`: existing land tests pass untouched.
- [ ] **Step 2: Run** `bun test packages/engine/test/land.test.ts packages/engine/test/stack.test.ts`; expect failures.
- [ ] **Step 3: Implement** the interfaces; keep the existing abort/`merge.aborted` handling. Reconcile for `rebase` is unchanged (confirmed when the branch moved).
- [ ] **Step 4: Run** `bun test packages/engine`; expect PASS.
- [ ] **Step 5: Commit** (`feat(engine): land stacked runs: --onto rebase, parent-based PRs, order check`).

---

### Task 10: Restack children when the parent lands; `pr_retarget`

**Files:**
- Modify: `packages/engine/src/land.ts` (`checkChangeset`, `mergeChangeset` completion hook), `packages/engine/src/stack.ts` (`restack`), `packages/cli/src/runtime.ts` (call after a run finishes; options per child)
- Test: `packages/engine/test/stack.test.ts`, `packages/cli/test/lifecycle.test.ts`

**Interfaces:**
- Consumes: `ledger.stackedOn`, `PullRequests.setBase`, `landChangeset` (Task 9), effect kind `pr_retarget` (Task 7).
- Produces:
  - `restack(opts: LandOptions): Promise<LandOutcome>` in `stack.ts`: for a `staged` child whose parent is now `finished`: runs `landChangeset` (it now picks the target as `onto`, rebases `--onto`, re-gates if anything moved, pushes with lease), then for each repo with a PR performs effect `pr_retarget` (key `pr_retarget:<repo>`, `target` = PR url, `after` = target branch) calling `setBase`; reconcile: `confirmed` when the PR's base already equals the target (add a `base` field to `PullRequests.status`'s result, or a `find` return), else `abandoned` and redone. It emits no `human.input` and writes the usual `merge.staged` again.
  - Runtime: after `mergeChangeset` returns `merged` or `checkChangeset` returns `merged` for run A, call `restack` for every id in `ledger.stackedOn(A)` that is `staged` (errors are recorded as `merge.aborted` on the child, never thrown into A's result).

- [ ] **Step 1: Write failing tests:**
  - `parent_landing_retargets_child_pr_and_does_not_merge_it` (fake PR client records `setBase`; child stays `staged`; no `merge` call).
  - `two_children_of_one_parent_both_restack` (Review Focus 5).
  - `restack_conflict_aborts_child_only` (A's result is still `merged`; child run is paused with `merge.aborted`).
  - `pr_retarget_reconcile`: chaos at `before:`/`after:pr_retarget:<repo>` resumes to the same end state; an already-retargeted PR is `confirmed`.
  - Runtime lifecycle test: `approve merge A` then `status B` shows B staged on the target with the retargeted PR.
- [ ] **Step 2: Run** the two test files; expect failures.
- [ ] **Step 3: Implement** as above; add `base?: string` to the `PullRequests.status` result (gh: `baseRefName`) and set it in the fake client used by tests.
- [ ] **Step 4: Run** `bun test packages/engine packages/cli`; expect PASS.
- [ ] **Step 5: Commit** (`feat: restack and retarget children when their parent lands`).

---

### Task 11: Surfaces and docs

**Files:**
- Modify: `packages/cli/src/runtime.ts` (`describe` for `pr_retarget`; status), `packages/cli/src/main.ts` (usage text, status and watch lines), `packages/cli/src/output.ts`, `integrations/claude/skills/heph/SKILL.md` and `integrations/codex/AGENTS.md` (identical content), `docs/SPEC.md` (sections 2, 4, 6, 13, 16, 19), `docs/NOTES.md`
- Test: `packages/cli/test/watch.test.ts`, `packages/cli/test/usage.test.ts`, the skill-copy test

**Interfaces:**
- `heph status`/`explain` print `stacked on <A> (<A's status>)` for a stacked run; `heph watch B` ends with `waiting for <A>` when the only thing missing is the parent landing; in-flight units are listed in `status`.

- [ ] **Step 1: Write failing tests:** watch ends with the waiting line for a staged child of an unmerged parent; usage lists `--stack-on` and `limits.parallel` appears in `config explain`; the skill and Codex copies are byte-identical.
- [ ] **Step 2: Run** `bun test packages/cli`; expect failures.
- [ ] **Step 3: Implement** the output changes; add a short stacking and parallelism section to the skill (when to use `--stack-on`, that the child waits for the parent's merge, never approve); update SPEC (fan-out as built, stacking, `pr_retarget` in section 13's effect list, `stack_on` in section 6, section 19 step 3 progress) and NOTES (what was decided, the fork-point derivation, the spike result, what is not built: multiple parents, optimistic joins).
- [ ] **Step 4: Run** `bun run typecheck && bun run lint && bun test`; expect all green (native-sandbox tests need a non-sandboxed shell, see NOTES).
- [ ] **Step 5: Commit** (`docs/feat: stacking and fan-out surfaces and spec`).

---

### Task 12: Real-world verification (with the user)

**Files:** none new; extend `packages/engine/scripts/pr-smoke.ts` with a stacked variant.

- [ ] **Step 1:** Run the extended `pr-smoke.ts` against throwaway private sandbox repos (ask the user before creating GitHub repos): two stacked runs, B's PR based on `heph/A`, merge A, confirm B retargeted, merge B. Expected: both on `main`, runs finished.
- [ ] **Step 2:** On LegendsAO with the user: one stack of two runs, and one plan with two independent units at `limits.parallel: 2`. Record timings and any gate-flake or OMP-concurrency problems in NOTES.
- [ ] **Step 3:** Only if both pass and chaos is green, propose (do not make) the change of the `limits.parallel` default.
- [ ] **Step 4: Commit** the NOTES results (`docs: first stacked and parallel runs`).
