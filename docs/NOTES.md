# Notes

Open questions, spec pushback, and deferred ideas. The spec is not changed silently; anything here that should change it needs a decision first.

## Prototype results (Step 0)

Run on 2026-11-03 with `anthropic/claude-opus-5-5`, thinking high, via the OMP SDK, prompt `packages/core/prompts/planner.md`, hand-written repo maps. Raw results are in `out/` (gitignored).

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

## Environment and OMP

- **Names (SPEC section 20 open item), checked 2026-11-03.** The npm scope `@hephaestus` is taken: `@hephaestus/core` is an unrelated package published since 2022. `hephaestus` on GitHub is an existing user account, so no org of that name. The repo lives at `juano-morello/hephaestus`. Packages stay `private: true` until a publishable scope is chosen; the `heph` binary name and `.heph/` dir are unaffected.

- **Bun version.** The session prompt said Bun >= 1.3.14, but `@oh-my-pi/pi-coding-agent@18.16.0` declares `engines.bun >= 1.4.4`. The repo pins `>= 1.4.4` (root `engines`, CI uses 1.4.4).
- **OMP in-process works.** `createAgentSession()` from `@oh-my-pi/pi-coding-agent` (pinned `18.16.0`, same as the installed `omp` binary) runs fine inside our Bun process and picks up the existing `~/.omp` subscription login. Options used: `modelPattern`, `thinkingLevel`, `systemPrompt` (replaces OMP's coding prompt entirely; input was ~124 tokens for a trivial prompt), `toolNames: []`, `skills: []`, `contextFiles: []`, `enableMCP: false`, `enableLsp: false`, `disableExtensionDiscovery: true`, `SessionManager.inMemory()`. Session startup is ~200ms. No CLI fallback was needed.
- **SDK docs drift.** The bundled `examples/sdk/README.md` references `discoverModels`, which is not exported in 18.16.0. Expect the SDK surface to move between versions (SPEC section 20 open item). The engine should wrap OMP behind the worker interface and touch as few SDK symbols as possible.
- **Blocked postinstalls.** Bun blocked lifecycle scripts for `onnxruntime-node` and `protobufjs` (OMP transitive deps). The planner path does not need them. Revisit before using OMP as a full worker.
- **Usage accounting.** Assistant `usage.input` is tiny on cached prompts (`cacheRead` carries the bulk). Ledger usage should record input, output, cacheRead and cacheWrite separately, not only `input`.
- **Runtime-specific code.** The script uses `Bun.YAML` and `Bun.file`. SPEC section 3 wants runtime-specific code behind `db`/`proc`; config loading will need the same treatment (or a YAML dependency) when it becomes real code.

## Spec interpretations made in code (need confirmation)

1. **"Matching test task that precedes it"** (`test_precedes_implement`). Implemented as: a `test` task in the same project whose `covers` intersects the implement task's `covers`, and which is a transitive predecessor in the derived graph. Since edges come only from produces/consumes, this forces a convention: test tasks produce `test:<Name>` and implement tasks consume it. The spec never says this. Options: (a) document the `test:` convention in the spec, or (b) let code add implicit test -> implement edges by `covers`, which contradicts "edges are derived only from produces/consumes". **Decided 2026-11-03: (a)**, written into the SPEC section 8 plan gate and the `produces` comment.
2. **One matching test is enough.** An implement task covering AC1 and AC2 passes if a preceding test covers only AC1. Stricter ("every criterion an implement task covers has a preceding test") is easy to switch to; `criteria_covered` already guarantees each criterion is tested somewhere.
3. **Implement tasks with empty `covers` fail.** This blocks pure support refactors that serve no criterion. Intended? **Related, decided 2026-11-03:** an implement task whose `covers` are only gate-checked criteria also fails, with its own evidence line ("covers only gate-checked criteria"); every implement task stays test-locked. Written into SPEC section 8.
4. **Every criterion needs a `test` task, even ones only a gate can check.** "buf lint and buf breaking pass" is a gate result, not a test. The planner has to invent a test task (for example a Go round-trip test) to cover it. The ablation showed this is the one systematic failure. **Decided 2026-11-03: option A**, applied to SPEC sections 3, 8 and 11. Gate names available per project are a resolved-config input (`fixtures/gates.yaml` in the prototype; real config per SPEC section 5 later). A test task listing a gate-checked criterion fails `criteria_covered`, so an implement task whose `covers` are only gate-checked criteria fails `test_precedes_implement` with "no test task covers". Options considered:
   - **A (chosen): the Criterion declares its check.** `Criterion = { id, text, kind, check?: { gate: string } }`, defaulting to a test. `criteria_covered` then requires: test-checked criteria are in `covers` of a `test` task (as today); gate-checked criteria are in `covers` of some task whose project has that gate configured (built-in or `.heph/gates/`). The engine runs the gate as that criterion's acceptance evidence, so the requirement-to-test mapping (section 11) becomes requirement-to-check. Deterministic, keeps intent in the Brief, and the planner never guesses. Cost: a gate-name registry per project, which the prototype fixtures do not have yet.
   - **B: such properties are constraints, not acceptance.** The Brief already says "passes buf breaking" under `constraints`, and lane `wide` gates enforce it anyway. The Claude Code skill and AGENTS.md teach the chat agent to keep acceptance to testable behavior. Zero schema change. Cost: no link from the property to a task or to gate evidence, and the brief gate cannot detect a violation (that would be a judgment call).
   - **C: the planner declares the gate.** A task field like `verifies: [{ criterion, gate }]`; code checks that the gate exists in the task's project. Cost: an LLM decides what counts as verification, and that judgment belongs to the Brief author.
   - Rejected: overloading `kind: "nonfunctional"` to mean gate-checked. Nonfunctional criteria are often testable (allocation-free tick, latency budgets via benchmarks).
5. **No task kind for editing a protocol schema.** The prompt tells the planner that editing `.proto` files is `kind: codegen` in the schema project. The spec should say which kind protocol edits are, since test-before-implement only applies to `implement`.
6. **Duplicate producers fail `consumes_resolve`.** Two tasks producing the same artifact make edges ambiguous. Not stated in the spec.
7. **Unique task ids** are enforced by the Plan schema (superRefine). Not stated in the spec.
8. **Added a `projects_exist` plan gate.** Not in the section 8 list, but section 4 ("a task targets exactly one project") implies it. The brief gate also rejects duplicate criterion ids.
9. **Complexity floors.** Spec says only "wide cannot be trivial" plus "scope size, file count, lane and cross-repo contracts". Implemented floors: lane wide or irreversible => at least standard; consuming an artifact from another project => at least standard; more than 5 scope globs => complex. Verdict is always pass; bumps go in `evidence` and a `bumps` field. "File count" cannot be computed without the worktree, so glob count stands in for now.
10. **Size limits.** Defaults: 12 tasks, 8 globs per task, no empty scope, no bare `**` or `**/*`. All configurable via `PlanLimits`; these numbers are guesses.
11. **Glob overlap is conservative.** `parallel_scope_disjoint` uses a segment-wise glob intersection that may report overlap where none exists, never the reverse. The real gate should match globs against the actual file list of the worktree at plan time.
12. **"Parallel" = no path in the derived graph**, checked only within a project. In a monorepo two projects can have nested roots (path `.` and path `pkg/a`); then same-repo cross-project scopes can collide. Diff-scope at the repo level will need to account for that.
13. **`brief_hash` from the model.** An LLM cannot compute a sha256, so the script passes the hash in and checks the echo. Simpler: the engine stamps `brief_hash` itself after parsing and the planner never outputs it. Either way the hash is sha256 of sorted-key JSON of the parsed Brief. **Decided 2026-11-03: the engine stamps it.** The prompt no longer mentions it, `evaluatePlannerOutput` overwrites whatever the planner wrote, and the `brief_hash` failure bucket is gone. SPEC section 8 notes it under Plan.
14. **Evidence shape.** `GateResult.evidence` is `string[]` (one entry per finding). `Return.reasons[].evidence` in section 8 is a single `string`. Pick one; joining is trivial.
15. **Verdict vocabulary.** Gates use `pass | fail`; `Return.verdict` is `"red"`. Worth unifying (`green | red`?) before the ledger fixes the event shape.
16. **Pushback: the planner needs an honest exit.** SPEC section 8 gives workers `blocked`, but the planner can only return a Plan, so a contradictory or uncheckable Brief always becomes a plan that passes the gates (0/15 escalations on the messy briefs). With a one-section prompt change and an `escalate` output, it escalated 9/9 with correct reasons and did not escalate on realistic briefs. Proposal: `PlannerOutput = Plan | { schema: 1, escalate: string[] }`, where `escalate` goes back to the submitting agent like a brief gate failure, and SPEC section 14's "honest failure rate on should-escalate tasks" measures it. **Decided 2026-11-03: adopted**, written into SPEC section 8 (`PlannerOutput`, Escalation as the honest exit) and section 14 (`expect: escalate` golden tasks, false escalation rate). The prompt has a "When not to plan" section, `evaluatePlannerOutput` reports `escalate` outside the failure histogram, and the script counts escalations. **Also decided 2026-11-03:** section 6 gets `run.plan_escalated (reasons)`, and section 19 step 0 now has two targets: ~70% first-try validity on plannable Briefs, and should-escalate Briefs escalate while plannable ones do not.
17. **Optional fields written as `null`.** Planner output with `"context_budget": null` fails schema parsing. Proposal: the engine drops `null` optional fields before parsing (same spirit as stamping `brief_hash`). Small, but it is a schema rule the spec does not state. **Decided 2026-11-03: drop them.** `evaluatePlannerOutput` removes null-valued object fields at any depth before parsing (nulls inside arrays still fail), so an unknown key with a null value such as `covers_note` also disappears. Written into SPEC section 8.
18. **Criteria that span projects.** A criterion like "the server refuses and the client shows the message" can be covered by a test in one project only. Option: `Criterion.projects?: string[]`, with `criteria_covered` requiring a covering test task in each listed project. Not needed yet (the planner split it correctly 5/5), so this is noted, not proposed. **Decided 2026-11-03: not yet.** Revisit if a run covers a cross-project criterion in one project only.

## Deferred (urges noted, not built)

- **Planner correction edge.** The obvious next experiment: when a plan fails, send the gate evidence back once and measure second-try validity. That is engine behaviour (section 2 return paths), so it was not built here.
- JSON Schema generation from the zod schemas for editor autocomplete (section 3).
- Reading the real repos to build repo maps instead of hand-written ones (section 9 per-stack adapters). The real-repo maps are still hand-trimmed; a generated full file list would remove the guessed-path problem (stress test finding 6).
- A plan gate that matches scope globs against the worktree file list (no guessed existing files, no test globs that lock unrelated existing tests). Needs worktree access, so it is engine work.
- An execution gate that runs locked tests before the implement task and requires them to be red.
- A `heph plan` CLI surface around the same evaluation.
