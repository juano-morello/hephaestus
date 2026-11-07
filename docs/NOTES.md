# Notes

Open questions, spec pushback, and deferred ideas. The spec is not changed silently; anything here that should change it needs a decision first.

## Prototype results (Step 0)

Run on 2026-11-03 with `anthropic/claude-opus-5-5`, thinking high, via the OMP SDK, prompt `packages/workers/prompts/planner.md`, hand-written repo maps. Raw results are in `out/` (gitignored).

| Fixture | Projects | First-try valid | Tasks per plan | Time per run | Output tokens per run |
|---|---|---|---|---|---|
| stacking-cap | server | 5/5 | 4 | 31-39s | 3.3k-4.3k |
| loot-drop-msg | proto, server | 5/5 | 4 | 30-37s | 3.5k-4.1k |
| loot-drop-client | proto, server, client | 5/5 | 7 | 54-60s | 6.2k-6.8k |

No gate failed in 15 runs and nothing was bumped for complexity. The plans have the same structure in every run (proto codegen, then per-project codegen, then test, then implement, chained through `test:*` artifacts). Scopes are narrow and split test files from implementation files. The `risks` are concrete and caught a real inconsistency in the hand-written server repo map: `OnKill` was listed as a method on `*Zone` in a different package (now fixed).

**Ablation.** I ran the same fixtures with a stripped prompt (no rules section, no artifact-naming guidance, no worked example, no checklist; only the contract, schema, kinds, lanes and one line saying ordering comes from produces/consumes and tests come first). 3 runs each:

| Fixture | Stripped prompt valid | Failing gate |
|---|---|---|
| stacking-cap | 3/3 | none (1 complexity bump per run: wide data-table task marked trivial) |
| loot-drop-client | 0/3 | `criteria_covered`: "AC1: no test task covers it", every run |

**My read.**

- The ~70% target is met, with room to spare, on these three briefs. The model handles produces/consumes ordering, test-first, and parallel-scope separation even when the rules are barely stated.
- The one failure mode that showed up is **a schema/spec problem, not a prompt problem**. AC1 ("buf lint and buf breaking pass") is a gate check, not a test. Without the rules, the model honestly mapped it to the codegen task, and `criteria_covered` rejected it every time. With the full prompt, the model gets past the gate by listing AC1 in the `covers` of a Go server test that "builds a pb.LootDrop". That test cannot verify `buf breaking`. The gate passes, but the coverage is fake. See interpretation 4 below: criteria a gate can check need a way to say so.
- Complexity floors are the other place the prompt carries the weight. Unprompted, the model marks data-table and codegen tasks trivial. Code bumping them is the intended behaviour (SPEC section 10), so that is fine.
**After option A (gate-checked criteria, interpretation 4).** Loot briefs now mark AC1 `check: { gate: buf }`; prompt and script pass per-project gate names. Re-run on 2026-11-03, same model:

| Fixture | Full prompt | Stripped prompt | Task covering AC1 |
|---|---|---|---|
| stacking-cap | 5/5 | not re-run | n/a |
| loot-drop-msg | 5/5 | not re-run | proto codegen task, 5/5 |
| loot-drop-client | 5/5 | 3/3 (was 0/3) | proto codegen task, 8/8 |

The made-up test coverage is gone: no test task lists AC1, and with the stripped prompt the one systematic failure disappeared. The stripped prompt still marks wide codegen tasks trivial and code bumps them, as intended.

- **Caveat: 100% probably reflects how easy the test is, not how strong the planner is.** The briefs are clean (decisions settled, paths known), the repo maps are small and consistent, and the worked example has the same proto -> codegen -> test -> implement shape as two of the fixtures. Before trusting the number: run the planner against real repo maps, and add a messier brief that should fail or escalate (SPEC section 14 asks for one).

### Stress test: real repo maps and messy briefs (2026-11-03)

Fixture set: a real game repo, kept in a private suite outside this public repo. It is one git repo with two projects, `server` (Go, about 1100 files) and `client` (Godot). There is no proto project: the wire protocol is a frozen legacy text protocol implemented by hand on both sides, so nothing in this set resembles the prompt's proto -> codegen example. Repo maps are hand-trimmed (about 60 lines each). Gates add custom `ci`, `goldens` and `mysql` (server), and `checks` and `py_tools` (client). Same model, full prompt, 5 runs each.

| Brief | Kind | First-try valid | Failing gate | Tasks | Time per run | Output tokens |
|---|---|---|---|---|---|---|
| realistic-1 | realistic, server | 4/5 | `schema` 1x (`context_budget: null`) | 2-4 | 32-59s | 3.4k-6.4k |
| realistic-2 | realistic, server | 5/5 | none | 2-3 | 33-47s | 3.4k-4.9k |
| messy-contradiction | should escalate | 5/5 | none | 4-5 | 74-105s | 7.9k-11.3k |
| messy-cross-project | should escalate | 5/5 | none | 5 | 64-105s | 6.8k-11.0k |
| messy-vague-migration | should escalate | 5/5 | none | 3-4 | 51-81s | 5.2k-8.1k |

24/25 pass every gate, and no complexity bumps. The single failure is a **schema problem**: the model wrote `"context_budget": null` for an optional field, and zod `.optional()` rejects `null`. Either normalize `null` to absent for optional fields before parsing, or add "omit optional fields, never write null" to the prompt. I would do the former; it is deterministic and costs nothing.

**What the messy briefs were meant to catch, and what happened:**

- **messy-contradiction** (a decision keeps some state in memory, the constraints forbid storage changes, two criteria need that state to survive a restart). All 5 plans invented a new persistence mechanism and noted the choice in `risks`. That is a design decision the Brief never made, and it goes against the repo's own rule about which interfaces own that state. **Gates pass, plan is wrong.**
- **messy-cross-project** (one criterion spans server and client, two criteria are not checkable as written, a required owner approval is missing, a decision conflicts with a constraint). Better than expected: all 5 runs split the cross-project criterion into a server test task and a client test task. But all 5 also planned straight through the missing approval and covered the uncheckable criteria with stand-in tests. Every problem was listed in `risks`. **Gates pass, plan should not exist.**
- **messy-vague-migration** (two vague criteria, plus a hidden schema migration the Brief never names). The hidden migration was found 5/5: every plan has a `kind: migration`, lane `irreversible` task. The vague criteria were covered by proxy tests, which the plans themselves call proxies. **Gates pass; the plan is reasonable apart from the vague criteria, which should have gone back to the author.**

**Escalation ablation.** Same model, prompt plus one section ("When not to plan": if a decision or constraint contradicts a criterion, a criterion cannot be checked as written, an approval is missing, or the work needs something the Brief forbids or never mentions, output `{"schema": 1, "escalate": [reasons]}`; ordinary uncertainty goes in `risks`). 3 runs each:

| Brief | Escalated | Reasons given |
|---|---|---|
| messy-contradiction | 3/3 | no allowed persistence mechanism; whether an existing free-form field counts as touching storage; durability vs no blocking I/O |
| messy-cross-project | 3/3 | missing approval; two criteria not checkable; a criterion contradicts a decision; unapproved threshold |
| messy-vague-migration | 3/3 | two criteria not checkable; unmentioned irreversible migration and backfill |
| realistic-1 | 0/3 (all plans valid) | none |
| realistic-2 | 0/3 (all plans valid) | none |

The reasons are specific and correct, and the realistic briefs did not escalate (0/6). The variant prompt was a scratch file and is not committed; the added section is summarized above. So the planner already knows when a Brief is not plannable; it only lacks a way to say so.

**Gates that passed plans they should not have** (gates too weak, or a missing schema channel):

1. **No honest exit for the planner.** The Plan schema has no equivalent of `WorkerResult.blocked`, so a non-plannable Brief always comes back as a plan. This is the most important finding; see spec pushback 16.
2. **Coverage is nominal.** `criteria_covered` checks that a test task lists the id, not that the test can decide the criterion. Vague criteria ("feels consistent", "nothing breaks") were "covered" in 10/10 runs. Code cannot judge testability; the honest place to catch it is the brief gate (vague words) or the planner's escalation.
3. **Cross-project criteria are invisible.** Nothing tells the gate that a criterion needs both a server and a client test. The planner got it right 5/5 here, but one test task in either project would also have passed. A Criterion could carry `projects?: string[]`, requiring one covering test task per project.
4. **Test tasks that cannot fail first.** Several plans say the new tests "may already pass". Test locking assumes red-before-green; nothing checks it at plan time. That is an execution gate (run the locked tests before implement and require red), not a plan gate.
5. **Over-wide test scopes lock unrelated tests.** One run gave its test task a whole package's `*_test.go` glob, which locks dozens of existing test files for every later implement task. A plan gate could reject test globs that match existing files the task does not need, once it has the real file list.
6. **Guessed paths.** Of 113 literal non-test scope paths across all 25 runs, 24 do not exist in the repo. Most are intended new files, but one existing-file guess (a boot file under a name the repo does not use) appeared in 4 of 5 runs of one brief, so diff-scope would fail at execution. This is a **fixture problem** (the trimmed map lists packages, not every file), but it points at the same fix as interpretation 11: check scopes against the worktree's real file list at plan time.

**Classification.** Prompt problems: none found that the existing rules caused; the one prompt-level gap is the missing escalation instruction, which needs a schema change first. Schema/spec problems: `null` optionals, no escalation channel, no per-criterion project list. Fixture problems: missing file names in trimmed repo maps.

**After adopting Escalation (pushback 16).** Committed prompt (with "When not to plan"), same model, 3 runs per brief, all eight briefs:

| Brief | Should | Valid | Escalated | Other |
|---|---|---|---|---|
| stacking-cap | plan | 3/3 | 0 | |
| loot-drop-msg | plan | 3/3 | 0 | |
| loot-drop-client | plan | 1/3 | 2 | see below |
| realistic-1 | plan | 2/3 | 0 | `schema` 1x: `"covers_note": null` |
| realistic-2 | plan | 3/3 | 0 | |
| messy-contradiction | escalate | 0/3 | 3 | |
| messy-cross-project | escalate | 0/3 | 3 | |
| messy-vague-migration | escalate | 0/3 | 3 | |

- **The loot-drop-client escalations are correct.** Both say decision 5 ("item names come from the client's existing item name lookup in InventoryModel") points at a lookup the client repo map does not have: `InventoryModel` only has `apply_update(msg)`, and the protocol carries only `item_id`. That is a **fixture problem** in the original set that every earlier run planned around. **Fixed 2026-11-03:** `fixtures/repo-maps/client.md` now lists `InventoryModel.item_name(item_id) -> String` backed by `data/item_names.json`. Re-run: 5/5 valid, 0 escalated.
- **`null` placeholders again.** realistic-1 is the only brief where the model writes `null` fields (`context_budget` once, now an unknown `covers_note` once; 2 of 8 runs). Dropping null-valued keys before parsing (pushback 17) fixes both cases; adopted afterwards.
- Escalation on should-escalate briefs: 9/9 again. Plannable briefs whose inputs are consistent: 0 escalations in 12 runs.

**Does the ~70% target still hold?** For gate validity, yes, easily: 24/25 on real maps, and 39/40 overall. But the number is less meaningful than it looked. On Briefs that should not be planned, 100% "validity" is a failure, and the gates cannot tell the difference. I would redefine the step 0 metric as two numbers: first-try validity on plannable Briefs (target ~70%, currently ~97%), and honest escalation on should-escalate Briefs (currently 0/15 without an escalation channel, 9/9 with one). The planner's judgment is the strong part; the schema needs to let it act on that judgment.

## Golden tasks (Step 1)

Set up on 2026-11-03. Decisions:

- **Oracle shape:** project-scoped lists (`hidden_tests: [{project, from, to}]`, `must_pass: [{project, run}]`, `must_not_touch: [{project, paths}]`), so one task can check several projects. SPEC section 14 example updated. `must_pass` commands run from the project root.
- **Where suites live:** a private directory outside this public repo and outside the repos the harness checks out (`~/Workspaces/heph-evals/`, its own local git repo). The real-repo fixtures that were committed here moved there. This repo keeps only the schema (`src/schemas/eval.ts`), checks (`src/eval/check.ts`), the loader (`src/eval/suite.ts`), `scripts/eval-check.ts` and a synthetic example suite on the toy fixtures (`fixtures/evals/`).
- **Oracles are written by the user** (SPEC section 14). Each task has an oracle README listing what to assert per criterion. `eval-check` reports a task as `needs_oracle` until its hidden test files exist, `invalid` on schema, brief-gate, project or pin problems, and checks every pinned commit with git.
- **Category mapping.** The real workspace is one repo with two projects and no protocol project, so SPEC section 14's categories map as: server only; a server wire-format change stands in for "protocol + server"; client logic only; cross-project (server + client in one repo) stands in for "cross-repo"; one should-escalate task (`expect: escalate`). A real multi-repo or schema-project case still needs a workspace that has one.

Open:

- **History rewritten 2026-11-03.** The real-repo fixtures and the detailed stress-test write-up were removed from every commit before the first push; the details live in the private suite.
- **The cross-project task changes code in one project only.** The other project's side is tests locking an existing contract. No documented defect in the real repo needs code on both sides without an owner decision.
- **No runner yet.** Applying hidden tests, running `must_pass` and checking `must_not_touch` need worktrees and the engine (v0). Until then the suite measures planner-side metrics only (first-pass validity on plannable tasks, escalation on should-escalate tasks) via `plan-proto`.

Planner smoke on the three new plannable briefs (opus, high, `--runs 1` each): 3/3 valid on the first try, 0 false escalations. Plans had the expected shape: test then implement in one project for the single-project tasks; for the cross-project task, a client test and implement plus a server test task that locks the existing contract (and one optional docs task). The should-escalate task is the one already measured in the stress test.

## Ledger (v0 step 1)

Built 2026-11-03 in `packages/ledger` (`openLedger(dir, { nodeId })`): append-only SQLite events (WAL, UPDATE and DELETE blocked by triggers), a content-addressed blob store, and materialized projections (`runs`, `units`, `attempts`, `gate_stats`, `usage`) updated in the append transaction and rebuildable. `bun:sqlite` is used only in `src/db.ts`.

Interpretations made in code (confirm or change):

1. **`run.created` data** adds `brief_hash` and `eval: boolean` to `owner_node`. The eval flag is how "eval runs are flagged and excluded from real-run stats" is implemented: `gate_stats` skips eval runs, `usage` keeps them with `eval: true`.
2. **`run.plan_ready` carries the Plan inline** in `data`, not in a blob, so the units projection can be built by a pure reducer without reading blobs. Plans are a few KB.
3. **Attempt outcome** is `green | red | blocked | error`; interruption is its own event (`unit.attempt.interrupted`, reason `rate_limit | crash | handoff | user`) and never counts toward the 3 attempts.
4. **Usage** records `input, output, cache_read, cache_write` separately (cached prompts report a tiny `input`).
5. **Required envelope fields per type:** `unit.*` needs `unit_id`, attempt-scoped events also `attempt`, `node.*` needs `graph_node`. A `unit.returned` Return must match the envelope's unit and attempt.
6. **Unknown types:** `append` rejects them; reads return them as `{ known: false }` with raw data, and projections skip them, so a ledger written by a newer node still opens.
7. **Two orders:** `id` (ULID) is the global order used by reads; `seq` (rowid) is local arrival order, used as the projection cursor. They coincide until sync brings in events from other nodes.
8. **Blob refs must exist locally** when an event is appended. Synced events will need a different rule (blobs may arrive after events).
9. **`gate.result` data is the core `GateResult`**, strict: extra fields such as the complexity gate's `bumps` must go into `evidence` when logged.

Not built here: intent/effect/confirm events (v0 step 7), sync ingest (v0 step 8), gate flakiness beyond counts, and where the per-node dir lives (daemon).

## Engine (v0 step 2)

Built 2026-11-03 in `packages/engine`: `runPlan()` runs an approved Plan one unit at a time in derived order, at most 3 attempts per unit, against pluggable `Worker` and `UnitGate` interfaces, on one git repo. Process spawning lives only in `src/proc.ts`. Tested end to end with a real temp repo and ledger; the OMP worker (2.3), built-in gates (2.4) and multi-repo set merge (2.5) are not built.

**Spec conflict, decided 2026-11-03: keep `heph-attempt/`**, written into SPEC section 13. SPEC section 4 names the changeset branch `heph/<run>` and section 13 names attempt branches `heph/<run>/<unit>/a<attempt>`. Git cannot have both: a ref cannot be a branch and a directory of branches at once. The code keeps `heph/<run>` (user-facing) and uses `heph-attempt/<run>/<unit>/a<n>` for attempts, built in one place (`attemptBranch` in `src/engine.ts`). Alternatives: `heph/<run>/changeset` plus the section 13 names, or `heph/<run>--<unit>--a<n>`.

Interpretations made in code:

1. **The worker returns no diff.** SPEC section 3 lists `diff` in the spawn result; the engine commits the worktree and reads the diff from git instead, so the worker's view is never trusted.
2. **Every attempt gets a commit**, even an empty one, so each attempt branch is a complete record.
3. **Locked paths** are all files changed by accepted `test` tasks in the same project that precede the unit in the derived graph. A test task that also touched non-test files would lock those too; the diff-scope gate (2.4) is what keeps test tasks to test files.
4. **Invalid worker output or an error exit counts as an attempt.** It is recorded as a failing synthetic gate `worker_output`, so it shows up in `gate_stats` and in the Return.
5. **A gate that throws fails** with reason "gate crashed".
6. **Interrupted or rate-limited attempts pause the run** (`run.paused` with `rate_limit` or `user`) instead of retrying, since resume is v0 step 7. They never count.
7. **The Return's scope is the task scope**, not yet narrowed to the failing files.
8. **No tier bump between attempts**; every attempt runs at the sanity-bumped tier (escalation routing is after v0).
9. **`run.finished` means the build node finished.** The run branch holds the changeset; no `merge.*` events until the set merge (2.5).
10. **The run branch is reset to `baseRef` at run start.** Calling `runPlan` again for the same run id restarts it; resume (2.7) must reconcile instead.
11. **`runPlan` checks `plan.brief_hash` against the Brief** and rejects a mismatch before writing any event.

## OMP worker in a sandbox (v0 step 2.3)

Built 2026-11-03: `packages/sandbox` (container and native modes, `proc` moved here) and `packages/workers` (`createOmpWorker`, five sandboxed tools, role prompts in `prompts/roles/`, live smoke in `scripts/worker-smoke.ts`).

**SPEC section 12 open item, answered.** OMP 18.16.0 has no pluggable execution backend. Its built-in file tools (`read`, `write`, `edit`, `grep`, `glob`, ...) run inside the OMP process on the host and accept any path, including `~/.ssh`; `bash` is an in-process native shell; `PI_SHELL_PREFIX` is unquoted and `ClientBridge` covers only commands. So the worker turns every built-in off (`restrictToolNames`) and gives the model its own `read`, `write`, `edit`, `bash` and `submit_result`, which act inside the sandbox. OMP, credentials and model calls stay on the host. Settings are `Settings.isolated`, with no MCP, LSP, extensions, skills, rules, context files or model fallback, so nothing in the worktree can reconfigure the session. Written into SPEC sections 12 and 20 (approved 2026-11-03).

**Container mode:** one container per attempt, only the project dir mounted at `/work`, `--network none`, your uid, CPU and memory limits, timeouts enforced inside the container. The image needs `sh`, `cat` and `timeout`. On macOS, Colima only mounts `$HOME`, so worktrees must live under it.

**Native mode** (confined since 2026-11-03): file paths are confined with realpath (symlinks can't escape); commands run with only `PATH`, `LANG` and `HOME`, under `sandbox-exec` on macOS or `bwrap` on Linux: writes only in the project and temp, no outbound network (unix sockets allowed on macOS), and credential paths in the home directory unreadable (`.ssh`, `.aws`, `.gnupg`, `.config/gh`, `.omp`, `.docker`, `.kube`, keychains, ...; `denyRead` overrides). Native mode refuses to open when neither tool exists. Reads elsewhere stay allowed so toolchains in the home directory keep working. CI installs bubblewrap and allows unprivileged user namespaces.

**Model names:** routing keeps `provider/model` ids; the worker passes the part after `/` to OMP's fuzzy matching (`claude/sonnet` -> `sonnet`). `providerOf` in the engine uses the part before `/` for usage rows.

**Live smoke (2026-11-03, sonnet, alpine container):** 2 units, both green on the first attempt, 139 s, 6.3k output tokens (86k cache reads). Nothing outside the project changed; the probe showed no `~/.ssh`, no host filesystem above `/work` and no network.

**Finding: the worker never sees the acceptance criteria.** `UnitBrief` (SPEC section 8) carries the task (with `covers` ids only), constraints and the context pack, but not the criterion text and not the Brief's `decisions`. In the smoke run the test author was told to cover "AC1, AC2 and AC3" without their meaning, so it invented AC2 and AC3: the required "non-integer argument exits 1" case was never tested or implemented, and the weak inline gates passed it. **Fixed 2026-11-03 (approved):** UnitBrief now carries `criteria` (the covered Brief criteria with their text; gate-checked ones are marked) and `decisions`, written into SPEC section 8, filled by the engine and rendered in the prompt. Second live smoke: finished, and `test_add.sh` covered the real AC1-AC3 (including the non-integer exit 1 with stderr and empty stdout) while `add.sh` validated its arguments. That run's attempt and token counts were not captured.

## Built-in gates (v0 step 2.4)

Built 2026-11-03 in `packages/engine/src/builtin-gates.ts`; `builtinGates()` returns them cheapest first. The engine opens one fresh gate sandbox per attempt (same spec as the worker's, `RunPlanOptions.gateSandbox`) when any gate needs it, and always disposes it.

| Gate | Rule |
|---|---|
| `diff_scope` | every changed file is inside the project and matches a task scope glob |
| `locked_paths` | no changed file is a locked path |
| `touched_vs_diff` | `touched` equals the changed files exactly, both directions reported |
| `tests` | after a `test` unit the test command must fail (red before green), after any other unit it must pass; fails if no test command |
| `typecheck`, `lint` | must pass; skipped for `test` units and when no command is configured (recorded as a pass that says so) |

Evidence for command gates is the exit code plus the last 60 lines (4000 characters) of output. A command past `gateTimeoutMs` (default 10 minutes) fails its gate.

Known limits:

1. **Red first cannot tell a right-reason failure from a broken test file.** A test unit with a syntax error also leaves the suite red. Parsing per-stack test output would fix it; not in v0.
2. **`touched_vs_diff` is exact.** A worker that formats extra files fails it. The spec intends this; watch whether it is noisy in real runs.
3. **Fixed 2026-11-03:** a typecheck or lint command containing `{files}` runs on the unit's changed project files (shell-quoted), so it also runs for test units; commands without `{files}` are still skipped for test units.
4. **Fixed 2026-11-03:** a modified locked file is reported once, by `locked_paths`; `diff_scope` leaves it alone.
5. Not built: coverage delta, project-imports-headless (Godot), requirement-to-check mapping at execution time, the integration gate at merge (2.5), custom gates from `.heph/gates/`.

**Live smoke on the built-ins (2026-11-03, sonnet, alpine container):** finished in 180 s, both units green on attempt 1, all 12 gate results recorded (T1: tests red as required; T2: tests green; typecheck and lint skipped as configured). 10.1k output tokens, 167k cache reads. The generated `test_add.sh` covered AC1-AC3 and `add.sh` validated its arguments.

## Multi-repo changesets and landing (v0 step 2.5)

Built 2026-11-03. `runPlan` now takes `workspaceRoot` and per-repo `targets`; every touched repo gets `heph/<run>` from its target, units run in worktrees of their own repo, and the run ends at `built` after the workspace integration gate. Landing is a separate call (`landChangeset`, exposed as `heph approve merge` in 2.6); `checkChangeset` follows pull requests.

Decided with you: land as one ready-for-review PR per repo (you merge on GitHub), local fast-forward for repos without a remote, rebase and re-gate when a target moved, integration gate in a container over the assembled changeset, and `autoMerge` only for all-contained runs.

How it works:

- **Integration gate:** every workspace repo is checked out (detached) in the workspace layout, touched repos at `heph/<run>`, the rest at their target; the `integration.gate` script runs over it in a sandbox. Red pauses the run; none configured is recorded as skipped.
- **Order:** repos land in `depends_on` order (a repo whose projects depend on another repo's projects goes after it).
- **Moved target:** the run branch is rebased onto the new tip in a temp worktree. A conflict aborts (`merge.aborted` with the files, then `run.paused`); nothing has been pushed or merged at that point. After any rebase, each touched project's configured commands (test, typecheck, lint) run again, then the integration gate; red aborts.
- **With remotes:** each `heph/<run>` is pushed with a lease on its previous remote value, one PR per repo is opened in order, then every PR body is edited to list all of them in merge order. `merge.staged` records the refs and PR urls; the run is `staged`. `checkChangeset` finishes the run when every PR is merged (recording the merge commits) and aborts when one is closed unmerged.
- **Without remotes:** `refs/heph/staging/<run>` per repo, then each target is fast-forwarded with an expected old value; if one fails, the ones already moved are rolled back.

Interpretations and limits:

1. **Fixed 2026-11-03: the engine merges.** `mergeChangeset` (`heph approve merge`) merges nothing until every PR is open, not a draft, mergeable, green and still at the staged head, then merges them in `depends_on` order with `gh pr merge --match-head-commit`, then fast-forwards local-only repos. A failure after the first merge is recorded as half-landed (`merge.aborted` "half-landed: merged ..."): a merged PR cannot be undone, only reverted.
2. **Fixed 2026-11-03:** mixed repos land: remote ones as PRs, local ones staged and fast-forwarded once the PRs merge (in `mergeChangeset` or `checkChangeset`).
3. **The re-gate after a rebase runs only what each project configures.** During a unit, a missing test command fails the `tests` gate; after a rebase it is a regression check, so an unconfigured project simply isn't re-run.
4. **Rebased commits are rewritten.** Attempt branches keep the original commits; the run branch points at the rebased ones.
5. **Verified live 2026-11-03** (`packages/engine/scripts/pr-smoke.ts`): two private sandbox repos (`juano-morello/heph-sandbox-proto`, `-server`, since deleted), branches pushed, two PRs opened with sibling links, both merged by the engine, files on `main`, run finished.
6. **Run status** gains `built` (clean build node) and `staged` (`merge.staged`); `PROJECTION_VERSION` is 2, so older ledgers rebuild on open.

## The heph CLI (v0 step 2.6)

Built 2026-11-03 in `packages/cli`: `heph init`, `config explain`, `new [feature]`, `plan show`, `plan revise`, `approve plan`, `run`, `status`, `explain`, `hint`, `cancel`, `approve merge`, `merge status`, all with `--json` (payload schemas in `src/output.ts`). `bun run heph ...` for development; `bun run build:heph` compiles `dist/heph` (124 MB, needs nothing next to it). The layered config and `config explain` were built in a side session.

Decided with you: in-process now (daemon in 2.8 wraps `src/runtime.ts`), the core run-lifecycle commands, approvals as `human.input` kind `approve`, layered config with sources.

How it works and what I interpreted:

1. **The node's home** (`$HEPH_HOME`, default `~/.heph`) holds `ledger.db`, `blobs/`, `worktrees/` and the node-level `config.yaml`. Run ids are `r-<yyyymmdd>-<6 hex>` unless `--run-id`.
2. **`run.created` carries the Brief and the workspace root**, so `plan revise`, `run` and the merge commands rebuild everything from the ledger.
3. **Planner loop:** (changed 2026-11-05: now the first answer plus one correction, see "Planner correction edge" below) up to 3 answers per `new` or `revise`; failed plan gates (and schema errors as a `plan_schema` result) are recorded as `gate.result` with `graph_node: plan` and fed back into the next prompt. After 3 invalid plans the run fails. An Escalation stops the loop at once. Plan gates run against the workspace's real file list.
4. **Approval is tied to a plan version:** `approve plan` names the `run.plan_ready` event id; a revision makes a new one, so `run` refuses until it is approved again.
5. **Landing is two steps:** `landChangeset` stages (rebase and re-gate if a target moved, push and open PRs where there is a remote, staging refs otherwise); `mergeChangeset` merges PRs and fast-forwards local repos. `heph run` stages right after a clean build; `heph approve merge` merges. `autoMerge` (library option) does both.
6. **Hints and budgets:** `heph hint <run> <unit> "<text>" [--budget N]` writes `human.input`; the engine adds every hint for that unit or for the whole run to the next attempt's constraints, and the latest budget override for the unit to its context pack.
7. **Cancel** writes `run.failed` ("cancelled by user"); a running build checks before each unit and each attempt and stops. An attempt already in flight finishes when no daemon drives the run (see "Handoff wait (2026-11-06)": under a daemon, cancel aborts it).
8. **Gates available to a project** for gate-checked criteria are the built-ins (`tests`, `typecheck`, `lint`, `diff_scope`, `locked_paths`, `touched_vs_diff`) plus its configured `gates`.
9. **Repo map** for the planner is the tracked file list per project (`repoMapFromFiles`), trimmed to 200 lines, until per-stack adapters exist.
10. **Progress output:** `heph run` prints one line per ledger event to stderr through the ledger's `onAppend` hook; `--json` keeps stdout to the envelope.
11. **Packaging:** prompts are text imports (embedded in the binary; typed with sidecar `.d.md.ts` files). `omp-legacy-pi-modules` is left external in `build:heph`: it is a virtual module of OMP's own build, reached only by its legacy plugin loader.

**Live smoke (2026-11-03, `dist/heph`, opus planner, container sandbox):** `init`, `new` (29 s, planned on the first answer), `plan show`, `approve plan`, `run` (114 s; both units green on attempt 1, every gate streamed, staged), `approve merge` (merged), `status` finished; `main` has `add.sh` and `test_add.sh`. The planner rated both tasks `trivial`, so the default routing used haiku.

Not built: `--on local|devserver`, handoff/adopt/sync (2.8), `eval`, `retro`, `--dry-run`, presets, workflows, custom gates from `.heph/gates/`. `heph init` writes `.heph/` into the repo for a single-repo workspace and does not commit it.

## Resume and idempotency (v0 step 2.7)

Built 2026-11-04 in `packages/engine` (`src/effects.ts`, `buildRun`, `land.ts`) and `packages/cli`. SPEC sections 6 and 13 now describe what is built.

Decided with you: explicit `effect.intended` / `effect.done` events, a fresh attempt budget for an escalated unit on resume, `heph run` waits out a rate limit in the foreground, chaos at every crash point plus real kills.

How it works and what I interpreted:

1. **Fresh or resume:** a build is fresh when there is no `node.started` (build) since the latest `run.plan_ready`; only a fresh build resets the run branches. A revised plan therefore always starts from the targets again.
2. **Atomic verdicts:** an attempt's gate results and `unit.attempt.finished` are written in one batch with what follows from them: the run-branch advance intent (green), the Return (red), or the escalation and pause (blocked). `unit.accepted` is written with the advance's `effect.done`. Without this, a crash between a green verdict and the advance would spend an attempt (and on the third attempt, escalate a green unit).
3. **Attempt numbers continue across the whole run**, also across plan revisions (they used to restart at 1 per build). The budget counts finished attempts since the latest plan or the unit's last escalation. A crash after the last red attempt but before its escalation escalates on resume without a new attempt, the same as if it had not crashed.
4. **Reconciling a rebase:** confirmed when the run branch moved away from `before`, because only the rebase moves it during landing. A landing re-run after a rebase always re-gates (any rebase since the latest plan), so a stopped landing can cost one extra re-gate, never a missing one.
5. **Reconciling GitHub effects** asks `PullRequests` (`find` by head, `status`); `pr_edit` is always abandoned and redone, since editing a body again is harmless.
6. **Failures vs stops:** an effect whose step throws is closed as `abandoned`. The tests simulate a kill with a `Stopped` error, which passes through the code that turns failures into `merge.aborted` or a half-landed result, since a killed process writes nothing. The in-process chaos test still lets `finally` blocks run (worktree cleanup); the SIGKILL smoke is where leftover worktrees and half-done attempts are real.
7. **Rate limits:** `heph run` waits until `retry_after`, or 60 s after the pause when there is none. **OMP reports a 429 but no retry-after**, so today every rate-limited run waits the 60 s default. `SpawnOutput.retry_after` is there for when a worker can read it.
8. **The pid lock** (`$HEPH_HOME/locks/<run>.lock`) is per node. Two nodes driving one run is the handoff/adopt problem of 2.8.
9. **`heph plan revise <run>`** without instructions is allowed only when the run has no plan yet (its planner was stopped); it plans from the Brief.

**Results (2026-11-04):** the chaos test finds about 45 crash points in one build, stage and merge with a red attempt and kills at each one: every resumed run matches the uninterrupted one (37 s; runs in CI). I checked it by mutation: confirming a run-branch advance without accepting the unit fails it. Before that, the test compared only trees, and the mutation passed, because redoing an accepted unit adds an empty commit with the same tree. Commit counts and one green attempt per unit now catch it. `chaos-smoke.ts`: seed 7, 10 of 10 the same; seed 42, 20 of 20.

**Live smoke (2026-11-04, `dist/heph`, container sandbox):** `heph run` SIGKILLed after T1 was accepted, while T2 attempt 1 was in flight. `status` showed `running`; the second `heph run` marked T2/a1 interrupted (crash), wrote `run.resumed` (crash), removed the leftover worktree, did not redo T1, took T2 green on attempt 2 and staged; `approve merge` landed `add.sh` and `test_add.sh`. T2 shows 1 attempt: the interrupted one does not count.

**Found after the live smoke, fixed:** the SIGKILL left T2 attempt 1's sandbox container running (`sleep infinity`, `--rm` only applies once it stops), mounting a worktree the resume had already removed. A killed process never runs `dispose()`. Containers now carry `heph.run` and `heph.node` labels, and every place that clears a run's leftover worktrees (build, landing) also removes its containers (`removeContainers`, through the engine's `reapSandboxes` option). Native mode has the same gap without a fix yet: a command runs in its own process group so its timeout can kill all of it, and a SIGKILL of heph leaves that group running until it ends on its own; there is no record to find it by.

Not built: chaos over golden tasks with a daemon (SPEC section 13 Testing; needs 2.8), handoff and adopt (both built since), interrupting a worker already in flight on `heph cancel` (built under a daemon since 2.8; still not without one, see "Handoff wait (2026-11-06)"), scheduler rerouting a rate-limited role.

## Node model (v0 step 2.8)

Built 2026-11-04 in `packages/node` (peer protocol, sync, workspace checkout, handoff, adopt), `packages/ledger` (import, cursors, single writer), `packages/engine` (coordinator and runner, abort signal) and `packages/cli` (host, daemon, node commands). SPEC sections 7, 13 and 16 now describe what is built.

Decided with you: daemon plus SSH (no network port, SSH keys as auth), named workspaces cloned on demand, handoff interrupts the attempt in flight, live test on denver.

How it works and what I interpreted:

1. **Sync cursors are the peer's `seq`, not ULIDs.** A ULID cursor would miss events that reach a node late through a third node (older ids arriving after newer ones).
2. **Single writer lives in the ledger:** `append` refuses an event for a run another node owns, except `run.created` and `run.adopted`. Every write path is covered, the CLI's included, which is why commands for a remote run are forwarded to the owner instead of written here.
3. **Leases and heartbeats are not built.** The only runner is in-process, where a lease can't expire; they come with cross-node runners (build order step 3). The coordinator/runner split is there (`Runner.runAttempt`), so that step adds a remote runner, not a refactor.
4. **A fresh build starts from `origin/<target>`** (fetched) when the repo has that remote, also for the integration gate's untouched repos. A node's local `main`, especially in a checkout cloned on demand, goes stale. Repos without a remote still use the local branch.
5. **`run.created` records the workspace name;** a node taking a run over resolves its own checkout from it. A runtime always uses its own node's checkout, never the path recorded by the node that created the run.
6. **Handoff recovery is "run it again".** A handoff stopped before `run.handed_off` leaves the old owner in charge; one stopped after it is finished by the old owner, which can still deliver (sync, take) though it can no longer write. Chaos-tested at every step.
7. **Handoff waits for nothing:** only the interrupt default is built (the attempt in flight is redone by the new owner). SPEC calls the policy configurable; waiting is not built.
8. **Builds reached through `heph peer` require the owner's daemon**, since a build tied to an ssh session dies with it. Reading and quick commands work through `heph peer` without a daemon.
9. **`heph run` through a daemon follows the job** by polling its events (1 s locally; each poll of a remote owner is one ssh round trip). Ctrl-C stops following, not the build.
10. **The daemon is the rate-limit scheduler:** a job that ends rate limited starts again and waits out `retry_after` inside the build; at start the daemon also resumes runs left `running` by a killed process.
11. **`--set` overrides apply only in-process.** A command that goes through a daemon uses the daemon's configuration.
12. **OMP loads lazily** (only to plan or build), and a Linux binary ships OMP's native addon beside it (`build:heph:linux` writes `dist/linux-x64/`; `fetch-natives.ts` takes the addon from npm at the version OMP resolved, after checking the registry's sha512). The first Linux binary died at startup because a binary cross-compiled on macOS carries only the macOS addon, and OMP loads it at import.
13. **`HEPH_DEPS_MODULE`** (a module exporting `deps`) injects a scripted planner and worker into heph processes that tests start (daemon tests, daemon chaos). It is a test hook only.

**Results (2026-11-04):**
- **Tests:** 459 pass (CI green).
  - Two nodes over an in-process transport and over a real `heph peer` process.
  - A real daemon killed mid-build that resumes by itself.
  - Handoff mid-build and stopped at each of its 7 steps.
- **Mutation check:** a handoff that skips pushing the run branches fails the handoff test.
- **`daemon-chaos.ts`** (seed 3, 10 runs): the daemon was SIGKILLed while the run was building in all 10. All 10 were resumed by the restarted daemon and matched an uninterrupted run.
- **On denver (Ubuntu 26.04 x86_64):** the Linux binary runs, `heph sync` from this Mac over real SSH pushed 2 events (then nothing on the next sync), and `heph daemon` serves its socket and stops cleanly.

**Live run on denver (2026-11-04):** OMP logged in there, the Linux binary and its daemon, a throwaway private repo (`juano-morello/heph-node-test`), and this Mac as the other node.

- **R1, created on denver from this Mac** (`heph new --on denver`): denver cloned the workspace and planned on the first answer (40 s). `status` from the Mac was synced over SSH. `approve plan` was forwarded. `heph run` was forwarded to denver's daemon, and every event streamed back to the Mac.
  - T2 escalated twice, because I configured `sh test_add.sh` and the planner had named the file `add_test.sh`. The second escalation exposed a real bug: the daemon cached each workspace's config, so it never saw the fix. Fixed: config is now loaded per command.
  - After the fix, T2 went green on attempt 7 (the escalations gave it fresh budgets, as designed). The run branch was staged and pushed to GitHub. Opening the PR then failed: denver has no `gh`, and that effect was closed as abandoned.
- **R2, built by this Mac's daemon and handed to denver once T1 was accepted:**
  - The Mac interrupted T2's first attempt (reason `handoff`), pushed `heph/R2`, and wrote `run.handed_off` 9 s after the handoff began.
  - Denver took the run 5 s later (`run.resumed`, reason `handoff`). It did not redo T1, took T2 red then green on attempts 2 and 3, and finished `built` 2 minutes after the handoff.
- **Findings:**
  - **A node that lands needs `gh`.** A node without it builds and pushes, but can't open the pull requests. Fixed on denver by installing gh and logging it in (HTTPS, gh as git's credential helper), and verified live by landing two runs from denver (below). heph now checks for it before giving a node a run.
  - **One remote URL for every node.** This Mac pushes over HTTPS (gh's credentials) and denver over SSH; denver's heph needed a `url.<ssh>.insteadOf <https>` rewrite (given through `GIT_CONFIG_*` in its environment) to clone and fetch. Any node of a run must be able to use the URL the run's checkout reports. On denver, gh as git's credential helper makes the HTTPS URLs work without the rewrite. heph doesn't translate URLs between nodes; the check below catches a node that can't use them.
  - **The planner isn't held to the project's test command (still open).** It named a test file the configured command didn't run. A plan gate could check test-unit scopes against the configured command.
  - **After a handoff, `heph run` on the old node ended with "paused (T2: handoff)".** Fixed: it now says where the run went and follows it there (below).
- **Cleanup:** `~/heph-test` on denver and the Mac's test home are removed, no containers are left on either machine, and both daemons are stopped. You deleted the GitHub repos (`heph-node-test` and the two sandbox repos from 2.5).

**Follow-ups to the live run (2026-11-04):**

1. **A node checks it could land a run before taking it.** `workspace.ensure` (a peer method) makes the node's checkout, then checks each repo: a `git push --dry-run` to `origin` (with `GIT_TERMINAL_PROMPT=0`, so missing credentials fail instead of prompting), and `PullRequests.preflight`, which for gh is `gh repo view --json viewerPermission` (needs WRITE, MAINTAIN or ADMIN). Problems come back one per line: `denver can't take workspace calc:` then `calc: gh can't reach the repo: ...`.
   - `heph new --on <node>` (and a preferred node picked for you) runs it before creating the run; when the preferred node refuses, the error says `heph new --on local` keeps the run here.
   - `heph handoff` asks for it before stopping the build, so a refused handoff leaves the build running on the old owner. Making the checkout first also shortens the time the run is stopped.
   - The dry-run push proves credentials and write access on GitHub (receive-pack needs both); a remote that accepts the ref advertisement but rejects the actual push would still pass.
2. **`heph run` follows a run across a handoff.** While a daemon is handing a run off, its `follow` answers "not done" (the old job's end is not the run's end); once the run is handed off, `follow` is forwarded to the new owner as for any remote run. The follower prints `handed off to denver`, `following it there`, then the new owner's events. The follow cursor is the last event id, which assumes the nodes' clocks are roughly in step (ULIDs start with a timestamp).

**Live re-run on denver (2026-11-04),** with gh 2.46 (Ubuntu's package) logged in over HTTPS as git's credential helper, no `insteadOf` rewrite, and a throwaway private repo (`juano-morello/heph-land-test`):

- **L1, `heph new --on denver` from this Mac:** denver's pre-check passed (dry-run push to the HTTPS remote, gh with write access) and it planned in 28 s. `heph run` built both units on the first attempt, pushed, and opened pull/1, then failed editing the PR body: gh 2.46's `gh pr edit` asks GraphQL for Projects (classic) cards, which GitHub has removed. **Fixed:** the body is now edited over REST (`gh api -X PATCH repos/<owner>/<repo>/pulls/<n>`), which works on any gh. After redeploying, `heph run L1` again finished staging in 5 s and reused pull/1 (no second PR). `heph approve merge L1` merged it from denver; `add.sh` is on `main`.
- **L2, built by this Mac's daemon and handed to denver while `heph run L2` followed it:** handed off during T2's first attempt (7 s); the follower printed `handed off to denver`, `following it there`, then denver's events through T2 attempt 2 green, the push, pull/2 and `staged`, and exited there. `heph approve merge L2`, forwarded to denver, merged it.
- **Findings:**
  - **The uncommitted heph files on a node's checkout didn't follow later changes.** `ensureWorkspace` wrote `.heph/workspace.yaml` and each repo's `.heph/config.yaml` only when missing, so a node kept the config from the first run it took (L2's test command had to be changed on denver by hand). **Fixed:** the sender's files now reach the owner:
    - **A checkout heph made** (`$HEPH_HOME/workspaces/<name>`) takes them whenever they differ, on `heph new --on`, on handoff, and before every command forwarded from a checkout of the run's workspace (`run` and the owner-only commands; a `workspace.files` request goes ahead of the `rpc` on the same connection). Editing the copy on the owner directly is overwritten by the next command from the sender: the sender's checkout is the one you edit.
    - **A checkout you configured** (`workspaces.<name>`) keeps its own files. Its files are yours to edit there, and heph writes only missing ones.
    - Not chosen: snapshotting the config into the run at creation. It would make a run reproducible, but a config fix mid-run (as on L1) would then need a way to change the run's snapshot.
  - **`heph approve merge` prints its result as JSON** (`merge of L1: {"status":"merged"}`) in human output. Cosmetic, from 2.6.
- **Cleanup:** both daemons stopped, `~/heph-test` on denver and the Mac's test home removed, no heph containers on either machine. You deleted the repo `juano-morello/heph-land-test`.

Not built: leases and remote runners (waiting for in-flight attempts on handoff was built later, see "Handoff wait (2026-11-06)"), a `heph nodes` listing, installing the daemon as a service, auth beyond SSH, passing `--set` through the daemon.

## Ready to use: install, doctor, the skill, and the first real repo (2026-11-04)

Goal set by you: use heph on real work without rough edges, starting with LegendsAO (Go server, Godot client). Built and checked against that repo, on this Mac and denver.

1. **`bun run install:heph`** installs heph here or, with `--remote <host>`, on another machine (SPEC section 16): binary in `~/.local/share/heph` with a `~/.local/bin/heph` link, `~/.heph/config.yaml` if missing, the daemon as a launchd agent or systemd user unit (with the installing shell's PATH, so it finds git, gh, go, docker, godot), the Claude Code skill and deny rule, then `heph doctor`. Rerunning upgrades in place: files are renamed into place (a running binary can't be overwritten on Linux) and the daemon restarts. A peer added with `--peer` gets `heph: ~/.local/bin/heph`, because a non-login ssh shell doesn't have `~/.local/bin` on its PATH.
2. **`heph doctor`** (SPEC section 16) found four real problems on its first runs:
   - **Every run used the 4.5 models.** OMP matches a bare `opus`, `sonnet`, `haiku` to claude-*-4-5. The default routing now names `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` (SPEC section 10 notes it). The live runs earlier today ran on haiku 4.5.
   - **From the home directory, the node's config was read as a repo's** (`~/.heph` is both). Fixed.
   - **OMP sessions can't start concurrently in one process** ("Agent Main was replaced"), so doctor probes models one at a time.
   - **A project missing from the target branch crashed `--tests`.** It is now that project's FAIL line.
3. **Native mode could not run a real Go test suite.** HOME was the project directory, so Go looked for modules there (and the network is off) and wrote its caches into the worktree, where they'd land in every diff; and macOS blocked loopback, which the server's tests use. Fixed (SPEC section 12, as built): a scratch HOME, Go on the host's module cache with the proxy off and a shared temp build cache, loopback allowed. The LegendsAO server suite (`go test ./...`) then passed in the sandbox on a clean clone in about 2 minutes. On macOS, loopback includes the host's own services; bwrap's is private.
4. **Pushback: the installer writes `sandbox: { mode: native }`, against SPEC section 12's container default.** Container mode can't build a real project yet: there are no per-project images, the network is off with no allowlist, and dependency caches aren't mounted (a `golang` image can't fetch LegendsAO's modules). Native is what works today. Options: keep native as the default until images, an allowlist and caches exist, or build those first. **Decided 2026-11-04: keep native.** The built-in default is now `native` (SPEC section 12 updated); container mode stays available.
5. **A run that can't leave this node stays here** unless you named one: with a preferred node, `heph new` in a workspace without remotes (LegendsAO) used to fail. It now plans here and says why.
6. **The skill** (`integrations/claude/skills/heph/SKILL.md`, Codex copy in `integrations/codex/AGENTS.md`): workspace setup, writing the Brief (acceptance as testable behavior, where tests live, no open questions), submitting and showing the plan, revising, running in the background, reading escalations with `explain` and passing your guidance with `hint`, and never approving. It tells the agent to name where tests live in the Brief's decisions, which works around the open finding that the planner isn't held to the project's test command.
7. **CLI polish:** `heph`, `heph help`, `--help`, `-h` print usage; `heph --version` prints the version and commit; merge results read as words.
8. **LegendsAO is set up** (its `.heph/` files, not committed): projects `server` (`go test ./...`, `go vet ./...`) and `client` (Godot); `sprites-modelling` dropped at your request; target `main`; no remote, so runs stay on this Mac and land as local refs.
   - **Godot 4.5.1** is installed per `client/toolchain.json` (official package, SHA-512 checked) in `client/build/toolchain/` of your checkout, linked as `~/.local/bin/godot` so worktrees and the daemon find it.
   - **The client's test command** (in `.heph/config.yaml`): imports content (10 s, gitignored output), runs the Python tools' 335 tests, then every headless `check_*.gd`, failing on a non-zero exit or any `SCRIPT ERROR`. It skips the 21 checks that fail on `main` today, the same in and out of the sandbox: native-harness and live-proof checks (`*_native*`, `check_live_core`, `check_playtest_package`, `check_native_form_windows`, which need the GDExtension or launch arguments), three that don't parse (`check_source_menus`, `check_source_prompts`, `check_source_accessibility`: warnings treated as errors), and ones with real failures (`check_source_feedback` 33 of 105, `check_wave_decode` 3, `check_operator_workflow` 2, and single failures in the form and source checks). It's an exclusion list so checks that units add run automatically; remove a name once that check passes.
   - **`heph doctor --tests` there: ready.** Client passes in the sandbox in 88 s, server in 216 s, each on a clean checkout of `main`. Every gate run costs about that much.
10. **Two first-run problems, found reviewing LegendsAO before its first run:**
    - **Landing into a checked-out target.** Without a remote, `heph approve merge` fast-forwarded `main` with `update-ref`; with `main` checked out, the files and index stayed behind and `git status` showed the run's changes reversed. Fixed: a checked-out target moves with `git reset --keep` (files follow, other edits stay, an edit that would be overwritten aborts the landing and rolls back the repos already moved).
    - **The client's sandbox was `client/godot`**, so a unit couldn't write the checks in `client/tools`. The client project's path is now `client` (and its test command runs from there). `heph doctor --tests` still passes both projects (client 84 s, server 216 s).
9. **Installer upgrade bug:** `launchctl bootout` returns before the agent is gone, so restarting a running daemon failed (error 5) and left it down. Fixed: it waits and retries.

## First real runs on LegendsAO (2026-11-04)

A presentation zoom for the Godot client, driven from Claude Code with the skill: three runs. The first dead-ended and was cancelled, the second staged and merged (7 files, +409/-37), and the third (a 2.5x factor on top) was building at the time of writing. What got in the way, and what changed:

1. **The plan could not go green.** T1 tested AC1 to AC7, but AC7 (a `MIGRATION_PLAN.md` entry) was only T5's, the last task, and every task must pass all of its project's tests. T2 passed 63 of 64 checks three times and escalated. **Decided: plan gate `tests_passable`** (SPEC section 9): in execution order, every criterion a test task checks is covered by the first non-test task in that project after it, or earlier. The planner prompt says so too.
2. **A hint couldn't widen a unit's scope.** Your direction to T2 ("also add the entry") was rejected by diff_scope, since the file was T5's. **Decided: `heph hint --scope <path>`** (SPEC section 16), recorded as a `human.input` of kind `scope`; the skill uses it only for files you agreed to.
3. **heph failed inside Claude Code's Bash sandbox** ("attempt to write a readonly database"; the agent retried outside it). The installer now adds `heph` to `sandbox.excludedCommands` in `~/.claude/settings.json`, and the error says what to do. My call: heph confines its own commands, and `heph approve` stays denied.
4. **`heph run` before the approval failed**, and each run needed an "approved now" message from you. `heph run` now waits for the approval (my call: the approval still gates the build; it just needn't be followed by a message). The skill starts it right after showing the plan.
5. **Every `heph run` reprinted the run from its start**, so a resume after a hint showed T1 again. It now prints from when it starts.
6. **touched vs diff:** the documenter listed `client/MIGRATION_PLAN.md` for a project-relative `MIGRATION_PLAN.md` and spent three attempts on it. The project's own repo-relative paths are now accepted.
7. **Smaller:** plans show each task's scope and criteria; attempt commits are titled by their unit with `Heph-Run`/`Heph-Unit`/`Heph-Attempt` trailers (`main` got four `heph: r-... T4 a4` commits); daemon log lines are timestamped; a second escalation says "3 more attempts (6 in all)"; a pause for you reads "waiting for you".
8. **Open: stacking.** You asked to build the 2.5x change on the unmerged zoom branch. A run always starts from its target, so you merged first. Building on another run's branch (and landing in order) is not built; it belongs with step 3.
9. **Seen, not a heph problem:** the agent's own Brief had a wrong decision number (23 was taken); the documenter refused to duplicate it, which is the `blocked` exit working.

## Following a run from the chat host (2026-11-04)

Feedback from using heph inside Claude Code: nothing told the agent what a background run was doing, and an obviously structural stall (a unit escalating over and over) cost attempts before anyone was asked. **Built: `heph watch <run>`** (SPEC section 16), a polling milestone stream that the skill starts with Monitor (Claude Code) and checks by hand in Codex. It ends with `waiting for you` or `the planner escalated`, and the skill tells the agent to explain and ask rather than retry. **Built later (2026-11-05): the MCP server** (`heph mcp`, SPEC section 16), with `heph_watch` as a cursor long-poll. Decision: the pull tool is the contract and MCP progress notifications are best-effort on top, because hosts differ in whether the model ever sees them. Stall detection, the second half of the feedback, was built the same day (below).

**Built after: stall detection (2026-11-05)**, the second half of the feedback (design: `docs/superpowers/specs/2026-11-05-stall-detection-design.md`). When a unit's last two red attempts fail the same way, the engine writes `unit.stalled` and pauses for the user instead of spending the rest of its attempts (SPEC sections 6 and 10). Decisions: the signature is the sorted failing gate, reason and evidence, hashed, with digits left alone (a noisy reason can only miss a stall); the threshold is 2 and fixed; the comparison spans a unit's escalation and resets at a hint, scope or run-level input; `heph resume` with no hint gives fresh attempts and stalls again after one more identical failure. `heph watch` ends on it as `waiting for you`; the skill says to explain and ask. Not built: near-duplicate signatures and plan-level stalls (different units failing alike).

### MCP server: follow-ups and known issues (2026-11-05)

Fixed since the first cut and no longer listed: shared watch classification, installer registration, the skill paragraph, bounded MCP daemon calls with transient-only retries, an overall bound per `heph_watch`/`heph_run` call, peer syncs inside reads bounded at about 5 s (one in flight per peer), `heph_watch` cancellation (in-flight calls aborted too), installer hardening (Codex `tool_timeout_sec`, `claude mcp` timeouts and scopes, TOML edge cases), empty-string inputs, `heph_run` on unapproved paused/built runs, the `serveStdio` wiring test, the e2e "starts nothing" check, and a plain `bun run build:heph` binary dying at start (it is now stamped with `HEPH_BUILD`, and `hephVersion` falls back to "unknown" when git cannot be spawned). What remains:

- The CLI's `heph watch` (`watchRun`) still retries every daemon error, and the CLI's daemon calls have no timeout. Left as it was on purpose: a person at a terminal sees the retries and can press Ctrl-C, and `heph run`/`heph new` must wait out the planner. Only the MCP path, where a host times the tool out, needed bounds.
- A `run` the MCP gives up on (its 10 s timeout, or `heph_run`'s 30 s budget) may still have started the build job on the daemon: the daemon is not told the caller left. Calling `heph_run` again then answers `already_running`, and the deadline error says so. Making `run` cancellable would need the daemon to undo a job it started; not worth it while the retry is safe.
- An aborted or timed-out daemon call ends on the MCP side only: the daemon finishes the work it had started (a read, or a peer sync that keeps going in the background until ssh drops it). It does not change anything a read would not.
- `registerClaudeMcp` reads `claude mcp get`'s human output (`Scope:`, `Command:`, `Args:` lines), whose format `claude mcp --help` does not state, and I could not see it for a stdio server without registering one. If the format changes, the worst case is a needless re-add, never a failed install.
- The read-side peer sync reuse (`refresh` in `host.ts`) keeps an in-flight sync for as long as it has not settled. If a peer's ssh link stays alive while its `heph peer` is wedged, every later read answers `possibly stale` without reconnecting until the daemon restarts. Still better than before (such a read used to hang). A cap on how long an in-flight sync may be reused would fix it. A read that joins a sync already past its pull phase gets no stale flag though the last few seconds of events may be missing.
- `withHephMcp` reads Codex's `config.toml` line by line, so a `"""`/`'''` multi-line string with an unbalanced `[` before the `[mcp_servers.heph]` table can leave a duplicate table. Rare; would need a real TOML parser to close.
- Checked 2026-11-05: `claude mcp get <name>` prints `<name>:` and then indented `Scope:` and `Status:` lines (seen for a claude.ai connector), and exits 1 for an unknown server. The `Command:`/`Args:` lines of a stdio server are still assumed.
- `heph mcp --json` prints one JSON line on stdout after the session closes. The host has hung up by then, so nothing reads it, and the stdout test sees only the JSON-RPC answers; it is the CLI's usual `--json` envelope, not worth a special case.

## Environment and OMP

- **Names (SPEC section 20 open item), checked 2026-11-03.** The npm scope `@hephaestus` is taken: `@hephaestus/core` is an unrelated package published since 2022. `hephaestus` on GitHub is an existing user account, so no org of that name. The repo lives at `juano-morello/hephaestus`. Packages stay `private: true` until a publishable scope is chosen; the `heph` binary name and `.heph/` dir are unaffected.

- **Bun version.** The session prompt said Bun >= 1.3.14, but `@oh-my-pi/pi-coding-agent@18.16.0` declares `engines.bun >= 1.4.4`. The repo pins `>= 1.4.4` (root `engines`, CI uses 1.4.4).
- **OMP in-process works.** `createAgentSession()` from `@oh-my-pi/pi-coding-agent` (pinned `18.16.0`, same as the installed `omp` binary) runs fine inside our Bun process and picks up the existing `~/.omp` subscription login. Options used: `modelPattern`, `thinkingLevel`, `systemPrompt` (replaces OMP's coding prompt entirely; input was ~124 tokens for a trivial prompt), `toolNames: []`, `skills: []`, `contextFiles: []`, `enableMCP: false`, `enableLsp: false`, `disableExtensionDiscovery: true`, `SessionManager.inMemory()`. Session startup is ~200ms. No CLI fallback was needed.
- **SDK docs drift.** The bundled `examples/sdk/README.md` references `discoverModels`, which is not exported in 18.16.0. Expect the SDK surface to move between versions (SPEC section 20 open item). The engine should wrap OMP behind the worker interface and touch as few SDK symbols as possible.
- **Blocked postinstalls.** Bun blocked lifecycle scripts for `onnxruntime-node` and `protobufjs` (OMP transitive deps). The planner path does not need them. Revisit before using OMP as a full worker.
- **Usage accounting.** Assistant `usage.input` is tiny on cached prompts (`cacheRead` carries the bulk). Ledger usage should record input, output, cacheRead and cacheWrite separately, not only `input`.
- **Runtime-specific code.** The script uses `Bun.YAML` and `Bun.file`. SPEC section 3 wants runtime-specific code behind `db`/`proc`; config loading will need the same treatment (or a YAML dependency) when it becomes real code.
- **Native-mode tests can't run inside another macOS sandbox.** `sandbox-exec` refuses to nest (`sandbox_apply: Operation not permitted`), so the gate, native sandbox and daemon tests fail when the test runner itself is sandboxed (as in a sandboxed agent session); they pass when it isn't, and on Linux CI (bwrap).

## Spec interpretations made in code (all decided by 2026-11-03)

1. **"Matching test task that precedes it"** (`test_precedes_implement`). Implemented as: a `test` task in the same project whose `covers` intersects the implement task's `covers`, and which is a transitive predecessor in the derived graph. Since edges come only from produces/consumes, this forces a convention: test tasks produce `test:<Name>` and implement tasks consume it. The spec never says this. Options: (a) document the `test:` convention in the spec, or (b) let code add implicit test -> implement edges by `covers`, which contradicts "edges are derived only from produces/consumes". **Decided 2026-11-03: (a)**, written into the SPEC section 8 plan gate and the `produces` comment.
2. **Decided 2026-11-03: strict.** Every test-checked criterion an implement task covers needs its own preceding same-project test (SPEC section 8). Was: one overlap was enough.
3. **Decided 2026-11-03:** implement tasks with empty `covers` keep failing: support work needs a criterion it serves. An implement task covering only gate-checked criteria also fails.
4. **Every criterion needs a `test` task, even ones only a gate can check.** "buf lint and buf breaking pass" is a gate result, not a test. The planner has to invent a test task (for example a Go round-trip test) to cover it. The ablation showed this is the one systematic failure. **Decided 2026-11-03: option A**, applied to SPEC sections 3, 8 and 11. Gate names available per project are a resolved-config input (`fixtures/gates.yaml` in the prototype; real config per SPEC section 5 later). A test task listing a gate-checked criterion fails `criteria_covered`, so an implement task whose `covers` are only gate-checked criteria fails `test_precedes_implement` with "no test task covers". Options considered:
   - **A (chosen): the Criterion declares its check.** `Criterion = { id, text, kind, check?: { gate: string } }`, defaulting to a test. `criteria_covered` then requires: test-checked criteria are in `covers` of a `test` task (as today); gate-checked criteria are in `covers` of some task whose project has that gate configured (built-in or `.heph/gates/`). The engine runs the gate as that criterion's acceptance evidence, so the requirement-to-test mapping (section 11) becomes requirement-to-check. Deterministic, keeps intent in the Brief, and the planner never guesses. Cost: a gate-name registry per project, which the prototype fixtures do not have yet.
   - **B: such properties are constraints, not acceptance.** The Brief already says "passes buf breaking" under `constraints`, and lane `wide` gates enforce it anyway. The Claude Code skill and AGENTS.md teach the chat agent to keep acceptance to testable behavior. Zero schema change. Cost: no link from the property to a task or to gate evidence, and the brief gate cannot detect a violation (that would be a judgment call).
   - **C: the planner declares the gate.** A task field like `verifies: [{ criterion, gate }]`; code checks that the gate exists in the task's project. Cost: an LLM decides what counts as verification, and that judgment belongs to the Brief author.
   - Rejected: overloading `kind: "nonfunctional"` to mean gate-checked. Nonfunctional criteria are often testable (allocation-free tick, latency budgets via benchmarks).
5. **Decided 2026-11-03:** protocol schema edits are `codegen`, written into SPEC section 8.
6. **Decided 2026-11-03:** an artifact produced twice fails `consumes_resolve`; in SPEC section 8.
7. **Decided 2026-11-03:** unique task ids, in SPEC section 8.
8. **Decided 2026-11-03:** `projects_exist` and duplicate criterion ids in the brief gate, in SPEC section 8.
9. **Decided 2026-11-03:** the complexity floors as implemented, in SPEC section 8.
10. **Decided 2026-11-03:** the defaults (12 tasks, 8 globs, complex above 5, no empty or bare `**`), configurable, in SPEC section 8.
11. **Fixed 2026-11-03:** with the file list (`projectFiles` in the engine, `plan-proto --workspace-root`), overlap is checked on the files globs actually match, and the new `scope_paths` gate fails scopes in directories that don't exist. A guessed filename in a real directory is only listed as a new file for review, not failed. Without the file list the conservative glob check still applies.
12. **Fixed 2026-11-03:** parallel overlap is checked across projects that share a repo, repo-relative.
13. **`brief_hash` from the model.** An LLM cannot compute a sha256, so the script passes the hash in and checks the echo. Simpler: the engine stamps `brief_hash` itself after parsing and the planner never outputs it. Either way the hash is sha256 of sorted-key JSON of the parsed Brief. **Decided 2026-11-03: the engine stamps it.** The prompt no longer mentions it, `evaluatePlannerOutput` overwrites whatever the planner wrote, and the `brief_hash` failure bucket is gone. SPEC section 8 notes it under Plan.
14. **Decided 2026-11-03:** evidence is a list everywhere (`Return.reasons[].evidence: string[]`), in SPEC section 8.
15. **Decided 2026-11-03:** keep gates `pass | fail`; a Return is always red.
16. **Pushback: the planner needs an honest exit.** SPEC section 8 gives workers `blocked`, but the planner can only return a Plan, so a contradictory or uncheckable Brief always becomes a plan that passes the gates (0/15 escalations on the messy briefs). With a one-section prompt change and an `escalate` output, it escalated 9/9 with correct reasons and did not escalate on realistic briefs. Proposal: `PlannerOutput = Plan | { schema: 1, escalate: string[] }`, where `escalate` goes back to the submitting agent like a brief gate failure, and SPEC section 14's "honest failure rate on should-escalate tasks" measures it. **Decided 2026-11-03: adopted**, written into SPEC section 8 (`PlannerOutput`, Escalation as the honest exit) and section 14 (`expect: escalate` golden tasks, false escalation rate). The prompt has a "When not to plan" section, `evaluatePlannerOutput` reports `escalate` outside the failure histogram, and the script counts escalations. **Also decided 2026-11-03:** section 6 gets `run.plan_escalated (reasons)`, and section 19 step 0 now has two targets: ~70% first-try validity on plannable Briefs, and should-escalate Briefs escalate while plannable ones do not.
17. **Optional fields written as `null`.** Planner output with `"context_budget": null` fails schema parsing. Proposal: the engine drops `null` optional fields before parsing (same spirit as stamping `brief_hash`). Small, but it is a schema rule the spec does not state. **Decided 2026-11-03: drop them.** `evaluatePlannerOutput` removes null-valued object fields at any depth before parsing (nulls inside arrays still fail), so an unknown key with a null value such as `covers_note` also disappears. Written into SPEC section 8.
18. **Criteria that span projects.** A criterion like "the server refuses and the client shows the message" can be covered by a test in one project only. Option: `Criterion.projects?: string[]`, with `criteria_covered` requiring a covering test task in each listed project. Not needed yet (the planner split it correctly 5/5), so this is noted, not proposed. **Decided 2026-11-03: not yet.** Revisit if a run covers a cross-project criterion in one project only. **Built 2026-11-06:** optional `Criterion.projects`, enforced by the brief gate and `criteria_covered`; see "Criterion.projects (2026-11-06)".

## Deferred (urges noted, not built)

- JSON Schema generation from the zod schemas for editor autocomplete (section 3).
- An execution gate that runs locked tests before the implement task and requires them to be red.
- A `heph plan` CLI surface around the same evaluation.

## Handoff wait (2026-11-06)

Design: `docs/superpowers/specs/2026-11-06-handoff-wait-design.md`. Closes the "waits for or interrupts in-flight units (configurable)" half of SPEC section 13 that v0 left unbuilt.

- **`heph handoff <run> <node> [--wait [seconds]]`.** With no flag a handoff interrupts the attempt in flight at once, as before. `--wait 300` lets attempts in flight finish for up to 300 s; a bare `--wait` waits up to `limits.attempt_timeout_ms` (20 minutes by default). Whatever is still running when the time is up is interrupted (reason `handoff`, not counted). The command blocks while it waits; `heph watch` shows progress. The wait starts only after the new owner has made its checkout, so a refused handoff never waits.
- **`--wait` parsing** (`packages/cli/src/wait-flag.ts`): `util.parseArgs` cannot take an optional value, so `--wait` is read first. `--wait` last or before another flag is "attempt"; `--wait N` and `--wait=N` are seconds (at least 1); `--wait=` with a non-number or 0 is an error; a word after `--wait` (for example `--wait R1 denver`) is an error that says to put the flag after the run and node, because the word may be the run id.
- **The drain.** `RunPlanOptions.drain` (engine) is a second signal next to `signal`: no unit starts and no unit starts another attempt, but workers are not aborted. A red attempt records its Return and stops with a `handoff` pause (the new owner continues from that Return); a green one still joins and is accepted. `stopSignal(opts)` picks the signal that stopped the build, and the pause reason is read from it. The daemon host gives each build job a drain controller; `stopJob(runId, reason, waitMs)` raises drain, waits up to `waitMs` for the job, then aborts as before. A handoff forwarded to the owning node carries the options (`wait` in the third argument of the `handoff` call), but the owner's `heph peer` process, which serves a forwarded call, has no build jobs, so neither the wait nor the interrupt reaches the owner's daemon build: `--wait` only takes effect when the handoff runs on the node that owns the run (found in the final review; true of forwarded handoffs since 2.8). Routing a forwarded handoff through the owner's local daemon is the fix.
- **Cancel, as it actually is.** Under a daemon `heph cancel` already interrupts the attempt in flight (`stopJob(runId, "user")` before `run.failed`); the earlier "still finishes its attempt" notes predate the daemon and the abort signal. A regression test pins it (`cancelling a run under a daemon`). Without a daemon, `heph cancel` only writes `run.failed`: a foreground `heph run` in another process notices at its next unit or attempt, and `heph run` has no Ctrl-C handler.
- **Not built:** cancel across processes without a daemon and Ctrl-C handling in `heph run`; aborting gate commands on cancel (not verified whether a gate in flight stops); a config key for a default wait; a `heph_handoff` MCP tool (none exists).
- **Tests:** the host tests for `--wait` assert what holds in any environment (the attempt in flight finishes uninterrupted and mbp starts no second one; a short wait interrupts it and denver starts T2 again). Whether the new owner's gates then pass depends on the sandbox the tests run in: in the agent sandbox native-sandbox gates cannot run, as for the existing handoff tests.

## Planner paths (2026-11-06)

Design: `docs/superpowers/specs/2026-11-06-planner-paths-design.md`. Closes stress test finding 6 (guessed paths).

- **`creates` on tasks.** Optional literal paths a task adds. `scope_paths` now fails a literal scope path that does not exist and is not in `creates`, with the closest existing names in the same directory (`closestNames`: names sharing the stem first, then edit distance); a `creates` path that already exists or is outside scope fails; a leading `./` fails. Test tasks lose their blanket exemption for literal paths (globs in a new directory still pass for them). Plans without `creates` stay schema-valid; their new files now fail the gate and go back through the one correction.
- **Collapsed repo map** (`packages/workers/src/repo-map.ts`). A project over 200 files renders as a tree within the budget: directories the Brief mentions (path, last path segment of 3+ characters, or a file name unique in the project) or that the last failure's evidence names are listed in full; the rest are `dir/ (N files)`; leftover budget opens more levels, shallowest first. Small projects render as before. The CLI planner loop passes the Brief text and `pathsInEvidence(feedback)`.
- **Not done:** rejecting over-wide test globs that lock unrelated existing tests (finding 5; heuristic, not seen in real runs), a planner file-listing tool, and the live before/after measurement (`plan-proto` on the stress fixtures, plan task 4).
- Planner-gated test fixtures now declare `creates` (`cli/test/fixtures/deps.ts`, `lifecycle.test.ts`, `dashboard.test.ts`).

## Criterion.projects (2026-11-06)

Closes interpretation 18 (criteria that span projects).

- **Rule.** A criterion may set `projects: [<project>, ...]`: it then needs a covering test task in each listed project. Without `projects` (or with an empty array, treated as absent) any test task covers it, as before.
- **Gate evidence.** Brief gate, one string per problem: `AC2: projects names "x", which is not in the workspace`; `AC2: projects lists "client" twice`; `AC2: projects applies to criteria checked by tests; a gate check (check.gate) is per project already`. Plan gate (`criteria_covered`), one line per project lacking a `kind: "test"` task in that project whose `covers` includes the id: `AC2: no test task in project client covers it`. The criterion-without-`projects` evidence (`AC2: no test task covers it`) and every other check in that gate are unchanged.
- **Where enforced.** `packages/core/src/gates/brief.ts` (next to `known_paths`), `criteriaCovered` in `packages/core/src/gates/plan.ts`. Schema: `packages/core/src/schemas/brief.ts` (still `.strict()`). The MCP `heph_new` description embeds the generated JSON Schema, so it shows the field; its list of brief-gate rejections names the three new ones. Planner prompt rule 2 gains one sentence.
- **Backward compatible.** The field is optional; existing Briefs, their hashes and plans are unchanged (an absent field is not serialized).
- **Chat-host docs.** The Claude Code skill and Codex `AGENTS.md` (kept identical by a test) gain one rule: set `projects` on a criterion that needs tests in more than one project.

## Measuring the planner gates (runbook)

Compares the planner before and after the `creates` gate, the collapsed repo map and `test_scope_narrow`. It needs real model calls through OMP, which fail inside the agent sandbox (readonly database), so the user runs it. The stress-test fixtures are private: `~/Workspaces/heph-evals/legendsao/` (`briefs/`, `repo-maps/`, `workspace.yaml`, `gates.yaml`). Plannable briefs: `client-music-gate`, `event-npc-refs`, `minimap-teleport`, `nobility-busy-984`, `timerai-quarantine`; should-escalate: the three `messy-*`. `<repo>` is the real game checkout the workspace repos point at.

1. **Before** (commit `dc2adf2`), in a temporary worktree:

```bash
W=$(mktemp -d) && git worktree add "$W/before" dc2adf2 && (cd "$W/before" && bun install)
```

```bash
cd "$W/before" && for b in ~/Workspaces/heph-evals/legendsao/briefs/*.yaml; do bun run packages/workers/scripts/plan-proto.ts --brief "$b" --workspace ~/Workspaces/heph-evals/legendsao/workspace.yaml --runs 5 --correct --workspace-root <repo> --out "$W/out-before/$(basename "$b" .yaml)"; done
```

2. **After**, from current `main`:

```bash
for b in ~/Workspaces/heph-evals/legendsao/briefs/*.yaml; do bun run packages/workers/scripts/plan-proto.ts --brief "$b" --workspace ~/Workspaces/heph-evals/legendsao/workspace.yaml --runs 5 --correct --workspace-root <repo> --out ~/heph-measure/out-after/$(basename "$b" .yaml); done
```

3. Remove the temporary worktree: `git worktree remove --force "$W/before"`.

`--repo-maps` and `--gates` default to `repo-maps/` and `gates.yaml` next to the workspace file, which is what the private suite has. The old commit's `plan-proto` has no `test_scope_narrow` or `creates`; that is the point.

**Compare** (per brief and in total, plannable briefs only unless noted): first-try validity; second-try validity on first-try failures (report n); counts of `scope_paths`, `test_scope_narrow` and `criteria_covered` gate failures across first answers; whether any guessed existing file or over-wide test glob survived, by reading the plans in `--out` (a path the gate accepted that does not exist in the repo, or a test glob matching unrelated existing tests); escalation on the `messy-*` briefs.

**Success:** first-try validity on plannable briefs stays near the earlier ~97%; second-try validity on first-try failures is at least 60%; every guessed existing file or over-wide test glob a run produces is failed by a gate. If a guess survives, that is the evidence for reopening the file-listing tool below.

## Planner file-listing tool (decided not now, 2026-11-06)

The planner is a single prompt with no tools. Guessed paths are already covered by the `creates` gate, the collapsed repo map and the one correction pass. Revisit only if a real run (the runbook above) shows guessed paths surviving the gate.

## Routing (2026-11-06)

Design: `docs/superpowers/specs/2026-11-06-routing-design.md`. SPEC §10 and §17 carry the as-built behavior.

- **Start tier.** `routeTier` scores a task: +1 per matched file, +1 per 100 lines, +2 per criterion, +3 for a lane other than `contained`, +3 for cross-project input, planner vote (trivial 0, standard 1, complex 3), -2 for kind `docs`; floored at 0. `trivial` needs score 4 or less and the qualifier (lane `contained`, 2 or fewer files, 150 or fewer lines, 1 or fewer criteria, no cross-project input); score 14 or more is `complex`; otherwise `standard`; more than 5 scope globs floors at `complex`. All of these are first guesses, constants in code, not config.
- **Signals timing.** Files and lines are read from the run-branch tip when the unit starts (after predecessors are accepted), not at build start. The decision is stored in `routed` on the unit's first attempt, so resume reuses it. Only blobs have lines (a submodule gitlink counts as 0), and a file whose lines can't be read counts as 0 rather than failing the unit.
- **Rung.** Derived from the ledger (`unitHistory`): start tier plus `red` outcomes of recorded `unit.attempt.finished` events, not `unit.returned`. `error`, `blocked`, interrupted and rate-limited attempts add nothing. Escalation and stall reset only the attempt budget, not the rung.
- **Built-in `top` only with built-in tiers.** Config resolution (`packages/cli/src/config.ts`) drops a role's default `top` when any of its tier routes (`trivial`, `standard`, `complex`, `default`) comes from a non-default layer and no such layer set `top`, so a user who routes a role elsewhere is never escalated onto Opus; `config explain` and `heph doctor` see it gone. Cost: that user sets `top` to get an opus rung.
- **Fallback.** Optional per-role `fallback`; cooldown map is per build and in memory (60 000 ms default). Within one `runUnit` call a unit never returns to a provider that rate-limited it during that call (a local set). With no fallback configured nothing changes.
- **Mixed versions.** `AttemptInfo` is strict and gained `tier: top`, `routed` and `fallback_for`, so nodes on different versions cannot share a ledger (same as `stack_on`).
- **Tests changed.** Small tasks now start at `trivial`: the engine happy path expects T2 on `claude/haiku`, and the transport timeout override is keyed `trivial`. `heph config explain` lists `top` and `fallback` (regression test in `cli/test/config.test.ts`; it passed by construction).
- **Measure after a few real runs.** Compare `routed.tier` with the final rung per unit; that tunes the thresholds and seeds learned routing (v2).
- **Known follow-ups (deferred minors from the reviews).**
  - `resolveRoute` per attempt can throw mid-run for a role lacking a higher rung and `default`.
  - The escalation message miscounts the attempt number after an in-loop fallback (uses `used`; should use the last attempt number).
  - A pause after both providers rate-limit carries only the fallback's `retry_after`.
  - No test crashes between a unit's first `started` (with `routed`) and its finish.
  - The crossProject floor test does not exercise its floor code.
  - Provider-outage and auth-error fallback needs worker failure classes.
  - Remaining-budget tracking is not built.

## Planner correction edge (2026-11-05)

The loop already fed failed gates back (up to 3 answers), but the planner never saw the answer it was correcting, and nothing recorded which attempt produced what. Built:

1. **One correction.** The planner loop (in `packages/cli/src/runtime.ts`, not `engine.ts`) is the first answer plus one correction; two invalid answers fail the run. An Escalation on either answer is honored.
2. **The correction prompt** shows the previous raw output (cut at 40k characters) above the failed gates and evidence, and asks for the whole corrected Plan or an Escalation.
3. **`plan.answer` events** (attempt, outcome, failed gate names) make first-try vs second-try validity readable from the ledger.
4. **`plan-proto --correct`** corrects each invalid first answer once and reports first-try, second-try and overall validity (`correctionStats` in core). **`--seed-faults`** breaks each valid first answer with one known fault and runs only the correction: a mechanism test, reported apart from the model's natural rate.
5. **Success:** second-try validity on first-try failures >= 60% (report n; first-try validity is ~97%, so few natural failures); seeded faults fixed without introducing other failures; first-try validity unchanged (the first prompt is untouched).
6. **Cost of the cap:** a run that used to pass on the third try now fails. **Not measured yet:** no live model runs were made for this change, only unit tests with scripted planners.

## Fan-out spike: concurrent OMP sessions (2026-11-05)

Question: can the engine run independent units concurrently with OMP in one process?

- **The live spike could not run in this environment**: calling `createAgentSession` (via `probeModel`) failed with `attempt to write a readonly database` on `~/.omp/agent/agent.db` (sandbox, no OMP write access), so neither the concurrent nor the staggered case was observed. The earlier doctor finding ("Agent Main was replaced" when sessions start concurrently) stands as the only evidence.
- **Decision (default)**: serialize session creation in `createOmpWorker` with a process-wide promise chain (`serializeCreation`); sessions already created run concurrently. Keep the in-process runner; a subprocess runner (Task 5b) is not in scope for now.
- **Re-check**: Task 12's live run must confirm two units really run at the same time. If "Agent Main was replaced" still appears after creation is serialized, switch to the subprocess runner and bring Task 5b into scope.
- Test: `serializeCreation` in `packages/workers/test/omp.test.ts` (overlap never exceeds 1; a failed creation does not block the next).

## Stacking and parallel fan-out (2026-11-05)

Design: `docs/superpowers/specs/2026-11-05-stacking-fanout-design.md`. Built in tasks 1-11 on `claude/stacking-fanout-e82247`. Closes "First real runs" item 8.

**Decided and built.**
- `limits.parallel` (default 3, decided 2026-11-05 by the owner, to be tuned later; `1` restores the sequential order exactly): ready-set scheduler (`readyUnits` in core, `scheduler.ts` in the engine), drain on escalation, stall, `blocked` or rate limit, one `run.paused` (precedence handoff > user > rate limit), join under a per-repo lock with cherry-pick replay and a re-gate of tests, typecheck and lint when the run-branch tip moved (a `join` gate on conflict).
- `heph new --stack-on <run>`: `stack_on` on `run.created` and the `runs` projection (`PROJECTION_VERSION` 4), `ledger.stackedOn`; landing with `rebase --onto <onto> <fork point>` (effect key `rebase:<repo>:<onto7>`), the PR based on the parent's branch while the parent is unmerged, `mergeChangeset` of a child `not_ready` (`waiting for <parent>`) until the parent is finished; when the parent finishes (`approve merge` / `merge status`) staged children are restacked and their PR base retargeted (`pr_retarget` effect, `PullRequests.setBase`). after a restack that stopped (child `paused`): fix, `heph run <child>`, `approve merge <child>` restacks and retargets only (returns `restacked`), then the user approves again.
- Surfaces: `stacked on <A> (<status>)` in `heph status`, `in flight:` attempts there when more than one runs, `waiting for <A>` ending `heph watch` and MCP `heph_watch` for a staged child, `--stack-on` in usage, the skill and its identical Codex copy.

**Fork point derivation.** Never stored and no pin ref: it is the first parent of the oldest commit on `heph/<B>` carrying `Heph-Run: <B>` (attempt commits carry it; rebases and cherry-picks keep it). It stays right after the parent is rebuilt, rebased or squash-merged, which is why landing uses `--onto` and never a plain `rebase <target>`.

**Chain-walk ruling.** The design said the parent's branch already contains its ancestors. That holds only in repos the ancestors touched, so the base per repo is the nearest built or staged ancestor in the `stack_on` chain whose `heph/<id>` exists in that repo and whose latest plan touches that repo (its `run_branch_reset` effects since its latest `run.plan_ready`; a branch left over from an earlier plan is no base); finished ancestors are skipped; any other ancestor status makes the stack unresolvable (fresh build pauses, plan/revise refuse, landing aborts). Landing (`onto`, PR base), planning refs and the integration gate use the same choice.

**Restack-trigger ruling (final review).** Whether a staged child needs a restack is decided from the ledger, not from its PR's base (GitHub changes that by itself): its parent's first `run.finished` is newer than the child's latest `merge.staged` (ULID order), in a repo with a pull request that an ancestor still unmerged at that staging touched. `mergeChangeset` refuses on it (`staged before <A> landed; heph approve merge <B> restacks it ...`), `approve merge` restacks on it (or on a PR whose base is still not the target), and `restackChildren` leaves a child already restacked since the parent landed alone. The PR-base check stays as an additional guard. `approve merge` merges only a head staged before its own approval event; one restacked after it answers `restacked`. Cost if wrong: ledger-comparison logic to maintain.

**OMP concurrency spike.** Could not run: `createAgentSession` failed on a read-only `~/.omp/agent/agent.db` in the sandbox. Decision: serialize session creation process-wide (`serializeCreation`), keep the in-process runner. Task 12's live run must confirm two units really overlap; if "Agent Main was replaced" persists, a subprocess runner comes into scope.

**Traps found in review and fixed.**
1. A crash after `unit.escalated`/`unit.stalled` but before the single `run.paused` left a running run that resume re-granted attempts to: resume now detects the lost pause.
2. An ancestor that was neither built, staged nor finished was silently skipped, building the child without the parent's changes: the stack is now unresolvable.
3. A remote repo with a parent that was only built (no `heph/<A>` on the remote) failed raw at `pr_open`, and a child whose PR base was still `heph/<A>` after A finished could merge into it: landing refuses until the parent is staged, and `mergeChangeset` refuses while a PR base is not the target, with the restack-only recovery above.

**Traps found by the final review and fixed.**
1. `heph merge status B` finished a child whose PR a human merged on GitHub into `heph/<A>` (or before A landed): every PR read merged, so B was recorded finished though the target lacked it, and A was stuck. It is now recorded half-landed (`merge.aborted`, run paused) with `merged into heph/<A>, not <target>` or `merged before <A> landed`.
2. The restack trigger was the PR base: with auto-deleted head branches GitHub retargets B's PR to the target when A merges, so a child whose restack never ran (process died, lock busy) merged un-restacked and un-re-gated; and a concurrent `heph merge status A` could restack B between the approval and the merge, merging a head nobody approved. Fixed by the restack-trigger ruling above. `heph merge status` of a finished run now writes nothing (it used to append a second `run.finished`).
3. A leftover `heph/<ancestor>` in a repo the ancestor's current plan no longer touches was taken as the base, so a child was built and gated on work that will never ship. Fixed by the latest-plan rule in the chain walk.
Also: a lost pause is written in the same batch as `run.resumed` (a second crash between them hid the escalation), and a child owned by another node is skipped by the restack with `owned by <node>; run heph approve merge <child> there`.

**Amendments to the design (2026-11-05).** 3.1 per-repo base is the chain walk, not "the parent's branch contains its ancestors"; 4.1 rule 2 counts non-test tasks of any project as satisfiers, as the plan gate does (not "in that project"); 3.3 gained the `approve merge B` restack-without-merge recovery and the PR-base guard, and (final review) the restack trigger is the ledger comparison, with the PR-base check an additional guard; the status line is "built".

**Not built.** Large, decided not to build (owner, 2026-11-05): multiple parents per run (a `stack_on` list, bases merged from disjoint parents, landing after the last parent; a ledger schema change that breaks older nodes; revisit when a real diamond-shaped need appears) and cross-node runners (leases and heartbeats, a remote `Runner`, a subprocess runner as the prerequisite; revisit when one machine's CPU is the bottleneck). Small, left unbuilt on purpose:
- Optimistic (lock-free) joins: the join lock only serializes the advance and its re-gate, and gate time dominates; lock-free replay and retry would add a retry loop and new crash cases for a small gain. Revisit only if profiling shows join-lock wait is significant.
- Stacking across workspaces: a stack is a chain of branches in the same repos of one workspace; two workspaces share no repos, branches or ledger semantics, so there is nothing to base one on the other.
- Mixed-version sync: event schemas are strict, so an older node rejects a `run.created` with `stack_on`. Nodes are upgraded together and `heph doctor` flags a version mismatch; a tolerant ledger needs a protocol bump and an event filter.
- A stale `in flight:` after a crash: `heph status` reads the attempts projection, which keeps a `running` attempt until resume interrupts it. Cosmetic; it clears when the run resumes.
- Clock skew in the restack trigger: comparing each PR's staged base would need it recorded in `merge.staged`, a strict-schema change. The PR-base guard covers GitHub's auto-retarget, and both nodes are the owner's, with NTP.
- A child merged on GitHub by hand after its parent landed but before a restack is recorded finished: its PR base is then the target and its code is on the target, it was just never gated there.
- Throttling beyond the resume ramp: remaining-budget tracking per provider and rerouting a rate-limited role (SPEC section 17).

Known costs: a late parallel unit pays one extra gate run and joins serialize. Deferred from the final review: ready-set rule 2 ignored in-flight test tasks (closed by the test-barrier rule, see "Found live" below); the rest was built afterwards (see "Gaps closed" below).


**Live checks (2026-11-05).** `packages/engine/scripts/pr-smoke.ts --stacked` against two throwaway private GitHub repos passed every check: a stacked child's PR is based on the parent's branch; its merge is refused until the parent merges, and again until it is restacked; after the parent merges the restack retargets the PR to `main` without merging it; and the same holds when the parent is squash-merged on GitHub directly (the child's PR carries only its own commit). The full `bun test`, run outside the agent sandbox, is 718 pass and 0 fail (the MCP, daemon and native-sandbox tests included). Not yet checked live: concurrent OMP sessions with `limits.parallel` above 1 (the spike could not run; session creation is serialized, see the spike section) and a stacked pair of runs on a real repo. The default stays 1 until those pass.

**Found live (2026-11-05): test chains deadlocked at `parallel` 2.** A plan in one project with two independent test-to-implement chains (T1 test -> T2 implement for AC1, T3 test -> T4 implement for AC2) started T1 and T3 together; both were accepted, leaving two red tests, and `heph run` failed with `no unit can start: T2, T4`: ready rule 2 blocked T2 on AC2 (checked by accepted T3, no accepted satisfier) and T4 on AC1. Letting them run would not help: each implement unit's `tests` gate, and a join's re-gate, runs the project's whole suite and sees the other chain's red test (the engine regression shows the old scheduler also starting T4 while T1 was in flight and stalling it red). The sequential order the plan gate simulates never hits this. Fix: within a project a test unit is a barrier at its place in canonical order. It starts only when every unit of the project ordered before it is accepted and nothing else of the project is in flight, and no unit of the project ordered after it starts until it is accepted; non-test units between two tests still run together, and other projects are unaffected (design 4.1 rule 4). A first version (hold a test unit while its project has an open criterion) was caught in review deadlocking gate-accepted plans at `parallel` 1 too, e.g. two locked tests consumed by one implementation; the reviewer's narrower version (hold it only when a remaining satisfier does not depend on it) still broke the sequential order in a property test (an implementation ran before an earlier, unconsumed test of its criterion). `packages/core/test/ready-property.test.ts` runs gate-accepted plans to completion at free 1-3, checking progress, that free 1 is the sequential order, and that no test unit shares its project with another in-flight unit. The plan above now runs T1, T2, T3, T4. The final review's deferred minor M1 (rule 2 ignores in-flight test tasks) was this same class, deferred wrongly as low-risk; it is closed by the same rule.

**Live LegendsAO runs (2026-11-05).** Two server runs built with this branch's code in an isolated heph home. (1) A stack: a parent (a `World.Do` shutdown fix, `r-20261105-f17464`) and a child stacked on it (`unbanips` and transcript file modes, `r-20261105-ce03a9`, planned and built with `--stack-on`). The child's branch is the parent's tip plus its own four commits, the planner saw the parent's files, `heph status` shows `stacked on <parent> (staged)`, and both runs staged as local refs (LegendsAO has no remote). Merging them in order (`heph approve merge` parent, then child) was not done. (2) A `parallel: 2` run exposed the scheduler deadlock described above: T1 and T3 (two test units in one project) ran their attempts at the same moment, which also shows two OMP sessions running concurrently in one process without "Agent Main was replaced". After the barrier rule that run could not be resumed (its accepted set came from the old rule) and was cancelled; it was not re-run, since within one project the barrier rule serializes test chains, so fan-out now pays off across projects (server and client), not between two chains of one project. Both T2 units had also blocked once on file paths my briefs got wrong (the workers asked for one file each); a `heph hint --scope` for exactly that file fixed it. A second `heph run` started at the same instant in one heph home failed once with "database is locked" (the daemon normally owns the ledger).

**Default 3 (decided 2026-11-05).** The owner set `limits.parallel` to 3 ("stick to 3 as default, we can tune it later"). Within a project the test-unit barrier keeps plans sequential, so the gain is across projects and between non-test units. Caveats to watch: concurrent OMP sessions were seen working live with 2 concurrent attempts (session creation is serialized process-wide); provider rate limits and gate load (each gate run is minutes of CPU) are the things that will bite first. `limits.parallel: 1` restores the sequential order exactly.

**Gaps closed (2026-11-05, branch `stacking-gaps`).**
- Restack after the engine's `autoMerge`: when `runPlan`/`buildRun` with `autoMerge` merges a run, its staged children are restacked and retargeted (`restackChildren`, as `approve merge` and `merge status` do), never merged. A child that fails is paused on its own (`merge.aborted`, `run.paused`) and the parent still reports `landed`. The child's landing options come from the ledger (its brief, changeset and latest plan) and reuse the parent's gates, sandboxes and PR client. `RunPlanOptions.around` (the shape of the CLI's per-run lock helper) wraps each child's restack, so a caller that sets `autoMerge` can serialize against a concurrent `heph merge status`; by default there is no lock (the CLI never sets `autoMerge`).
- Rate-limit throttle (SPEC section 17, minimal and deterministic): a build resuming from a `rate_limit` pause starts at `max(1, floor(parallel / 2))` units at once and allows one more after each accepted unit, up to `limits.parallel`. It is derived from the ledger alone (`rateLimitRamp`: the latest non-crash `run.resumed` says `rate_limit`, plus the `unit.accepted` since), so a crash mid-ramp resumes at the same value. No new events: the throttle is visible only as the order units start in. `parallel` 1 is unchanged.
- A chaos `Stopped` in one parallel unit is rethrown by the scheduler at once instead of draining, and the build's ledger refuses every write after it (`untilKilled`), as does `effect()` before applying (`EffectScope.killed`): a killed process writes nothing more. Real errors still drain. Units left running keep their attempt-local git work (worktree, attempt branch), which a resume clears or redoes.
- `heph merge status` of a stacked run paused half-landed writes nothing more while the same half-landed reason stands and nothing was staged since (it used to append another `merge.aborted` and `run.paused` on every call).
- A joined commit is pinned at `refs/heph/join/<run>/<unit>-a<n>` from before its `run_branch_advance` intent until the unit is accepted, so a gc between a crash and the resume cannot prune what reconcile's `applied` path moves the branch to; every build start deletes the run's join refs after reconcile has closed every advance (`dropJoinPins`). No pin is written once the build was killed; an advance that fails (abandoned, e.g. a lost compare-and-swap) drops its own pin, and `heph cancel` drops the run's pins when no live process holds the run's lock (a live one drops its own as each join ends). `rejoin` adds its worktree inside the try, so a failed add is still cleaned up.
- Small: `PAUSE_RANK` lookups use own keys (`isPauseReason`), the plan-gate docblocks sit on their functions again and `Stale.by` is gone, `serializeCreation` chains with `then(fn)`, the ready barrier test is named for its rule and a direct test covers a non-test unit waiting for an earlier unaccepted test with nothing in flight. Not added: a test that `createOmpWorker` routes session creation through `serializeCreation`, since `createOmpWorker` always opens its sandbox through `openSandbox` and the native sandbox cannot run in the agent sandbox; `serializeCreation` itself is tested.

### Measured 2026-11-05

Opus 5.5, thinking high, `loot-drop-client`, via `plan-proto` (raw results outside the repo). The natural-failure run uses the stripped prompt (`packages/workers/prompts/variants/planner-stripped.md`, recreated from the 2026-11-03 ablation: no rules, artifact-naming, example or checklist sections), because the real prompt almost never fails first-try (2/2 here, 3/3 on stacking-cap).

| Run | n | First-try valid | Corrected valid | Overall valid |
|---|---|---|---|---|
| Stripped prompt, `--correct` | 10 | 7/10 (70%) | 2/3 (67%) | 9/10 (90%) |
| Real prompt, seeded faults (8 kinds x 2 plans) | 16 | 0/16 by construction | 16/16 (100%) | 16/16 |

- **Natural failures (3):** all three were `schema` failures. The correction fixed all three schema errors; one correction introduced a new failure (`test_precedes_implement`) and stayed invalid, the other two became valid.
- **Seeded faults:** one per plan-gate failure type (`unknown_project`, `uncover_criterion`, `dangling_consume`, `drop_consumes`, `unbounded_scope`, `migration_not_irreversible`, `missing_field`, `truncated_json`); `FAULTS` in core, each tested to trip its gate. All 16 fixed by one correction, none introduced anything. This tests that the evidence is enough to repair each kind of failure. It says nothing about how often the model fails.
- **Verdict.** The edge helps: on a prompt that fails 30% of the time it lifts validity from 70% to 90%, and the 60% second-try target is met (67%). One correction looks sufficient for evidence-shaped failures (all 16 seeded faults). **Caveats:** the natural second-try rate rests on n=3 failures, so 2/3 could be anywhere from about 20% to 95%; the stripped prompt's failures were all schema errors here, not the `criteria_covered` ones seen on 2026-11-03, so the mix is not stable; with the real prompt the edge has almost nothing to do (first-try ~97%). The one failed correction hit a different gate than the first answer; whether a second correction would have fixed it is unmeasured. **No decision changes**: the one-correction cap stands, and SPEC is unchanged.

## Dashboard (2026-11-05)

First slice: a read-only runs list and run page (SPEC section 16, "As built"). Branch `dashboard`.

**Decisions**
- React 19 + Radix primitives (Collapsible, Scroll Area, Tabs) + Tailwind 4, bundled by `bun run build:ui` into `packages/ui/dist`, which the daemon embeds. Motion is used for the running-node pulse and the row highlight, with `reducedMotion="user"` plus a CSS rule and a `matchMedia` gate.
- animate-ui and uiverse.io: neither was ported. The animate-ui registry (`https://animate-ui.com/r/<name>.json`) was reachable on 2026-11-05 and its license (MIT + Commons Clause, fetched from the project repo) was readable, but the Highlight primitive is a sliding highlight built on a `div` container and `layoutId` items and does not fit a `<tr>`, so `animate-ui/highlight-row.tsx` stays a local component following the pattern, with a header that says so. uiverse.io answered 403 (Cloudflare) to a scripted fetch, so no snippet or license text could be had; the running pulse is a local `.heph-pulse` CSS animation. No third-party code and no license text is carried.
- Palette: forest green, sand beige, electric purple, warm danger red; light and dark (media query plus a `data-theme` attribute). `packages/ui/scripts/contrast.ts` fails the build on text pairs under 4.5:1 and on non-text pairs under 3:1 (the pending-node outline uses `--border-strong`).
- Status is never color alone: every badge and graph node has an icon or glyph and its word. Focus (dashed ring) and selection (solid ring) on graph nodes differ in style.
- No SSE: the page polls. The token sits in the URL fragment (not sent in requests, not in server logs), is moved to `sessionStorage` and dropped from the address bar at load.
- The network surface is a 4-method read allowlist (`status`, `explain`, `planShow`, `dashboard`); writes are 404 even with the token.

**Not built:** approve, hint and cancel buttons; plan review; changeset diff summary; ledger charts; retro; MCP Apps widgets; SSE; dashboards for remote nodes.

**Rebuild and test.** `bun run build:ui` rebuilds the bundle (the `typecheck` and `build:heph*` scripts run it first). Tests: the backend packages (`bun test packages/core ... packages/cli`, the cli ones for the UI are ui-server, ui-command, ui-e2e, ui-wire, dashboard, ui-fixtures) and then `bun test --cwd packages/ui` (happy-dom; it must run from that directory because of its `bunfig.toml` preload, which is why the root `test` script runs it separately). **Plain `bun test` at the repo root is no longer supported** (it runs the ui tests without the happy-dom preload and fails with `sessionStorage is not defined`); use `bun run test`, which CI now runs.

**Real-browser check (built-in browser pane, 2026-11-05).** Setup: a real daemon on a temp `HEPH_HOME` with the ui-e2e fixture (`HEPH_DEPS_MODULE`), run R1 built to `staged` and run R2 left `running` (worker delayed, daemon restarted, so R2's ledger state is a mid-build snapshot). Checked and fine: the page loads with no console errors and no CSP violations (the animations and inline styles are not blocked, so the CSP in ui-server.ts is unchanged); runs list; run page graph; unit panel with attempts and gate results (R1 T2: five gates with pass); the running node and pending dashed node (R2); the newest attempt tab selected by default; light and dark; 375 px width (no page-level horizontal scroll, the graph scrolls inside its viewport: 440 px content in 341 px); keyboard-only selection (Tab to a node, dashed focus ring, Enter selects, panel opens); `#/run/%E0%A4%A` and `#/run/%` do not crash and show the runs list. **The check found a real bug**: the UI client read `body.result` and a string `error`, but the daemon replies `{ok, data}` and `{ok:false, error:{message}}`, so the page rendered empty against a real daemon (the unit tests used a fake with the wrong shape). Fixed in `api.ts`, with the test fakes changed to the real shape. It also showed noisy usage fields (run id, eval) in the header, now numeric counters only, and a UA outline box around a focused node, now removed. **Not checked:** a run with a failed attempt or red gate in the real page (no failing scripted worker; covered only by the happy-dom tests), the page on a real narrow phone, a screen reader, Safari and Firefox (the pane is one engine), a long-running poll across a daemon restart, a stacked run.

**Known follow-ups**
- (a) **Stale-port token leak.** `heph ui` trusts `ui.json` alone. If the daemon's UI listener did not start (the port was taken), or the daemon started without the bundle (`main.ts` logs "no UI" and leaves an old `ui.json` in place), `ui.json` names a port the daemon does not own. Loopback ports are not per-user, so any local user can hold that port, serve `<div id="root">`, and receive the token through the URL fragment `heph ui` opens. The token reads every run (briefs, plans, gate evidence) and stays valid until `ui.json` is replaced. Cheap fix: add the UI port to the daemon's `/health` reply and make `heph ui` require a match with `ui.json` before it prints or opens the URL.
- (b) Smaller test gaps: a raw chunked-body test, a test for the catch around `startUiServer`, and exclusive (`O_EXCL`) temp-file creation for `ui.json`.
- Small: the graph's `statuses[id]` lookups use a plain object (an id named `constructor` would pick up an inherited key).
- Compiled binary check (2026-11-05, at HEAD before this wave): `bun run build:heph`, then `./dist/heph daemon` on a temp `HEPH_HOME` from a directory without packages/ui: `/` 200 with the dashboard HTML (`<div id="root">`), `/assets/app.js` 200 (642052 bytes), `/assets/app.css` 200, `POST /api/status` without a token 401. The bundle is embedded in the binary.

**Differences from the design spec.** The Runs table shows Owner, not the spec's "workspace" column (the runs projection has no workspace column and this slice allows no schema change). Run-level gate results (the integration gate and landing re-gates carry no unit_id) are not shown; they appear only as pause reasons. The page retries by polling and has no retry button. The bundle builds to `packages/ui/dist`, not `dist/ui`. The animate-ui/uiverse outcome is as written above. The `dashboard` method returns the built shape (see the spec's "As built" note).
