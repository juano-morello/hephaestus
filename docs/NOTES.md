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

## Environment and OMP

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

## Deferred (urges noted, not built)

- **Planner correction edge.** The obvious next experiment: when a plan fails, send the gate evidence back once and measure second-try validity. That is engine behaviour (section 2 return paths), so it was not built here.
- JSON Schema generation from the zod schemas for editor autocomplete (section 3).
- Reading the real repos to build repo maps instead of hand-written ones (section 9 per-stack adapters).
- A `heph plan` CLI surface around the same evaluation.
