# Custom command gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project config can define command gates (`gates: { buf: "buf lint" }`), and the engine runs them: a gate runs on the units that cover a criterion with `check: { gate: <name> }`, plus `always: true` gates on every unit of the project.

**Architecture:** `ProjectLayer.gates` accepts the old list of names or a map of name to a gate spec; the loader normalizes every layer to a resolved map. The engine gets `EngineConfig.customGates`, a `namedCommandGate` and a pure `customGatesFor`; `localRunner` runs `extraGates(task)` after the built-ins; the runtime builds `extraGates` from config and the Brief. The dry-run preview lists the gates a unit would really run.

**Tech Stack:** TypeScript on Bun, zod 4, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-07-custom-gates-design.md`

## Global Constraints

- Reserved names, rejected as custom gate names (list form too): `tests`, `typecheck`, `lint`, `diff_scope`, `locked_paths`, `touched_vs_diff`.
- `always` without a `command` is a config error; a command string is shorthand for `{ command }`.
- A gate entry replaces as a whole across layers (path `projects.<p>.gates.<name>`).
- A selected gate with no command fails the attempt with exactly `gate <name> has no command in project <project>` (one red gate result, gate name `<name>`).
- Custom gate evidence is `exit N` plus the tail of output, like `tests`; timeout is `timeout_ms` from the spec, else the usual gate timeout; no `{files}` substitution.
- Custom gates never run in the join re-gate or the landing re-gate (`REGATES` stays `tests`, `typecheck`, `lint`).
- No ledger event, schema or projection changes.
- No attribution of any kind in commit messages (project CLAUDE.md overrides any harness reminder).
- `bun test <path>` per task. Baseline in the agent sandbox: about 70 tests in `packages/cli` and `packages/engine` and 18 in `packages/workers` fail before this work (native-sandbox nesting, daemon, landing, 'runPlan with the built-in gates'); `packages/cli` tsc reports 2 errors about unbuilt ui assets. Compare against a baseline checkout; judge flaky heavy-suite failures by rerunning the file alone.

## Review Focus

- A names-only (old list form) config still loads, and a unit that needs such a gate fails with the no-command message, not a crash. (Tasks 1, 2)
- A gate-checked criterion covered by a test unit, or by a unit whose project has no entry for the gate: no crash and a clear result. (Task 2)
- A custom gate that times out or exits non-zero: the Return carries `exit N` evidence and the next attempt proceeds; a passing gate leaves the unit accepted. (Task 2)
- Reserved name, `always` without command, unknown key: config errors name the exact key and file. (Task 1)
- The dry-run `gates` list equals what a real attempt would run for that unit. (Task 3)

---

### Task 1: The `gates` config shape

**Files:**
- Modify: `packages/core/src/schemas/config.ts` (`ProjectSettings`, `ProjectLayer`, new exports)
- Modify: `packages/cli/src/config.ts` (`isAtomic` ~line 49, `repoProjects` ~line 285)
- Modify: `packages/cli/src/runtime.ts` (line 149, the `projectGates` map)
- Test: `packages/core/test/config.test.ts`, `packages/cli/test/config.test.ts`, `packages/cli/test/schema.test.ts`

**Interfaces:**
- Produces (core, exported from `@hephaestus/core`):
  - `RESERVED_GATE_NAMES: readonly string[]` (the six names above).
  - `GateSpec` (layer form): `z.string().min(1) | { command?: string; timeout_ms?: positive int; always?: boolean }` (strict; the object form is rejected when `always` is true and `command` is missing, message `always needs a command`).
  - `ProjectGate` (resolved form): `{ command?: string; timeout_ms?: number; always: boolean }` (strict), and `type ProjectGate`.
  - `normalizeGates(gates: string[] | Record<string, GateSpec> | undefined): Record<string, ProjectGate> | undefined`: a list name becomes `{ always: false }`; a string spec becomes `{ command, always: false }`; an object spec keeps its keys with `always` defaulting to false; `undefined` stays `undefined`.
  - `ProjectLayer.gates` is `z.union([z.array(name), z.record(name, GateSpec)]).optional()` where `name` is `z.string().min(1)` refined to reject reserved names (message `<name> is a built-in gate and cannot be redefined`); `ProjectSettings.gates` is `z.record(z.string(), ProjectGate).optional()`.
- `repoProjects` (cli config) passes each project layer through `normalizeGates` before merging, so resolved `projects.<p>.gates` is always the map form. `isAtomic` also treats `projects.<p>.gates.<name>` (path length 4, `path[0] === "projects"`, `path[2] === "gates"`) as one value.
- `runtime.ts` line 149 becomes `[...BUILTIN_GATES, ...Object.keys(config.projects[p]?.gates ?? {})]`.

- [ ] **Step 1: Write failing tests.**
  - `core/test/config.test.ts`: `ProjectLayer` parses `gates: ["buf"]`, `gates: { buf: "buf lint" }`, `gates: { buf: { command: "buf lint", timeout_ms: 5000 } }`, `gates: { nc: { command: "x", always: true } }`; rejects `gates: ["tests"]`, `gates: { lint: "x" }`, `gates: { a: { always: true } }` (message `always needs a command`), `gates: { a: { command: "x", nope: 1 } }`, `timeout_ms: 0`; `normalizeGates` returns `{ buf: { always: false } }` for `["buf"]`, `{ buf: { command: "buf lint", always: false } }` for the string form, `{ nc: { command: "x", always: true } }`, and `undefined` for `undefined`; `ProjectSettings` accepts the resolved map and rejects the list.
  - `cli/test/config.test.ts` (follow how existing tests write a workspace and repo `.heph/config.yaml`): a list-form repo config resolves `projects.server.gates` to `{ buf: { always: false } }`; a repo config with `gates: { buf: "buf lint" }` resolves to `{ buf: { command: "buf lint", always: false } }`; a later layer redefining `buf` replaces the earlier entry whole (give the first `timeout_ms: 9000`, the second only a command, and assert the resolved entry has no `timeout_ms`); `explainConfig` lines include `projects.server.gates.buf.command = "buf lint"  (<repo config file>)`; a reserved name fails with a `ConfigError` issue whose `key` ends with the name and whose `file` is the repo config.
  - `cli/test/schema.test.ts`: `JSON.stringify(schemaFor("repo"))` contains `"always"` and `"timeout_ms"`.
- [ ] **Step 2: Run** `bun test packages/core/test/config.test.ts packages/cli/test/config.test.ts packages/cli/test/schema.test.ts` → the new tests fail.
- [ ] **Step 3: Implement** the interfaces; fix any other compile errors from `ProjectSettings.gates` changing type (only `runtime.ts:149` reads it today).
- [ ] **Step 4: Run** the three files, `bun test packages/cli/test/dry-run.test.ts packages/cli/test/init.test.ts` and `bunx tsc -b packages/core packages/cli` → pass.
- [ ] **Step 5: Commit** `core, cli: gates is a map of command gates; the old list of names still loads`.

---

### Task 2: Running custom gates

**Files:**
- Modify: `packages/engine/src/builtin-gates.ts` (add `namedCommandGate`), `packages/engine/src/config.ts` (`EngineConfig.customGates`), `packages/engine/src/runner.ts` (`LocalRunnerOptions`, gate loop ~line 290), `packages/engine/src/engine.ts` (`RunPlanOptions`, the `localRunner({...})` call ~line 485), `packages/engine/src/index.ts` (exports)
- Create: `packages/engine/src/custom-gates.ts` (`customGatesFor`)
- Modify: `packages/cli/src/runtime.ts` (`toEngineConfig` ~line 1036, `runOptions` ~line 353)
- Test: `packages/engine/test/custom-gates.test.ts`

**Interfaces:**
- Consumes: `ProjectGate`, `Criterion`, `Task` (core); `UnitGate`, `UnitGateContext` (engine gates.ts).
- Produces:
  - `EngineConfig.customGates?: Record<string, Record<string, ProjectGate>>` (project, then gate name). `toEngineConfig` sets it from `config.projects` for projects that have at least one gate; omitted when none. Because `configHash` canonicalizes the whole config, a changed command changes the hash.
  - `namedCommandGate(name: string, spec: ProjectGate | undefined, project: string): UnitGate` in `builtin-gates.ts`: `needsSandbox: true`; no `spec?.command` → one red result, reason `gate <name> has no command in project <project>`, evidence `[]`; no `ctx.sandbox` → red `no sandbox configured for gates`; otherwise `ctx.sandbox.exec(command, { timeoutMs: spec.timeout_ms ?? ctx.timeoutMs })`; `timedOut` → red `timed out after <ms> ms` with evidence `exit <code>` plus tail; exit 0 → green reason `<name> passed`; non-zero → red reason `<name> failed`, evidence `["exit N", <tail>]` (use the file's existing `result` and `tail` helpers).
  - `customGatesFor(o: { task: Task; criteria: Criterion[]; specs: EngineConfig["customGates"] }): UnitGate[]` in `custom-gates.ts`: first, for each criterion in order whose `check?.gate` is set and whose id is in `task.covers`, unless `task.kind === "test"`, a `namedCommandGate(name, specs?.[task.project]?.[name], task.project)` (a name that is selected but not defined in the project yields the no-command failure); then, for each entry of `specs?.[task.project]` with `always: true` in key order, `namedCommandGate`; no duplicates by name (a name selected both ways appears once, in the criterion-named position); `always` gates are included for test tasks too.
  - `LocalRunnerOptions.extraGates?: ((task: Task) => UnitGate[]) | undefined` and `RunPlanOptions.extraGates?: (task: Task) => UnitGate[]`: `buildRun` passes it to `localRunner`; each attempt runs `[...o.gates, ...(o.extraGates?.(t) ?? [])]` (built-ins first), the sandbox opens when any of those needs one, and `REGATES` still filters only `o.gates`.
  - Runtime: `runOptions(runId)` adds `extraGates: (task) => customGatesFor({ task, criteria: c.brief.acceptance, specs: engineConfig.customGates })`.

- [ ] **Step 1: Write failing tests** in `custom-gates.test.ts` (look at `packages/engine/test/builtin-gates.test.ts` for the scripted sandbox and gate-context helpers, and `engine.test.ts` for building a run with `RunPlanOptions`):
  - `customGatesFor`: a covering implement task with criterion `{ id: "AC1", check: { gate: "buf" } }` gets one gate named `buf`; a task whose `covers` lacks `AC1` gets none; a `kind: "test"` task gets none for it; an `always: true` gate is included for a test task and an implement task of its own project and not for another project's task; a name both criterion-named and `always` appears once; a selected name with no entry in the project still returns a gate (named, whose result is the no-command failure); order is criterion-named gates then `always` gates.
  - `namedCommandGate` with a scripted sandbox: exit 0 passes (`buf passed`); exit 2 fails with evidence starting `exit 2` and containing the tail; `timedOut` fails with `timed out after 100 ms` when `timeout_ms: 100` is in the spec and `ctx.timeoutMs` is larger; no command fails with exactly `gate buf has no command in project server`; a spec `timeout_ms` is passed to `exec`.
  - Engine: a run whose unit covers a gate-checked criterion, with `extraGates` built from `customGatesFor` and a scripted `gateSandbox` whose `exec` fails for the `buf` command on attempt 1 and passes on attempt 2: attempt 1 is `red` with a `gate.result` named `buf` carrying `exit 1`, the unit is returned, attempt 2 is accepted; and `needsSandbox` opens the sandbox when only a custom gate needs one (give the run `gates: []`).
  - `configHash`: two `EngineConfig`s differing only in a custom gate command hash differently.
  - The join re-gate does not run a custom gate (a join test or a direct check that `REGATES` filtering ignores `extraGates`).
- [ ] **Step 2: Run** `bun test packages/engine/test/custom-gates.test.ts` → fails (module missing).
- [ ] **Step 3: Implement** the interfaces and the runtime wiring.
- [ ] **Step 4: Run** `bun test packages/engine/test/custom-gates.test.ts packages/engine/test/builtin-gates.test.ts packages/engine/test/engine.test.ts packages/engine/test/stop.test.ts`, `bunx tsc -b packages/engine packages/cli` and `bunx biome check --write packages/engine packages/cli` → pass apart from baseline failures.
- [ ] **Step 5: Commit** `engine, cli: custom command gates run on the units that cover a criterion naming them`.

---

### Task 3: The dry-run lists the gates a unit would run

**Files:**
- Modify: `packages/engine/src/preview.ts`, `packages/cli/src/runtime.ts` (`dryRun`)
- Test: `packages/engine/test/preview.test.ts`, `packages/cli/test/dry-run.test.ts`

**Interfaces:**
- Consumes: `customGatesFor`, `builtinGates` (engine).
- `previewRun` input drops `projectGates` and gains `criteria: Criterion[]`; `PreviewUnit.gates` becomes `[...builtinGates().map((g) => g.name), ...customGatesFor({ task, criteria, specs: config.customGates }).map((g) => g.name)]`. `Runtime.dryRun` passes `criteria: brief.acceptance` and no longer passes `projectGates`.

- [ ] **Step 1: Write failing tests.** `preview.test.ts` (update existing expectations): `gates` for an implement unit equals the six built-in names; a unit covering a gate-checked criterion also lists `buf` last; an `always` gate appears on every unit of its project; a test unit lists no criterion-named gate. `dry-run.test.ts`: the preview's `gates` for each unit equals the built-in names (update the existing assertion if it names project gates).
- [ ] **Step 2: Run** `bun test packages/engine/test/preview.test.ts packages/cli/test/dry-run.test.ts` → the changed expectations fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the two files and `bunx tsc -b packages/engine packages/cli` → pass.
- [ ] **Step 5: Commit** `engine, cli: the dry run lists the gates a unit would run`.

---

### Task 4: Docs and the chat-host skill

**Files:**
- Modify: `docs/SPEC.md` (§11 and §5), `docs/NOTES.md` (new section "Custom command gates (2026-11-07)"; the "Not built" lines that mention custom gates), `docs/ROADMAP.md` (sub-project B), `integrations/claude/skills/heph/SKILL.md` and `integrations/codex/AGENTS.md` (change both the same way; a test keeps them identical)
- Test: the existing skill-identity test (`grep -rn "SKILL.md" packages/cli/test`)

- [ ] **Step 1: Update the docs.** SPEC §11: custom gates are command gates in project config, run in the sandbox, with why not TS files (repo code would run in the engine process that holds git push and secrets; SPEC §12 puts gates in the sandbox); built-ins list notes coverage delta and a TS `defineGate` as not built. §5 shows the `gates:` map example and `always`. NOTES "Custom command gates (2026-11-07)": the config shape and normalization, the reserved names, selection rules (criterion-named gates on covering units except test units; `always` on every unit of the project), the loud no-command failure, evidence and timeout, not in the join or landing re-gate, the config hash, the dry-run change, and what is deferred (TS gate files, coverage delta, `{files}`, lane gates, a Godot stack in `heph init`). Fix the "Not built" lines in NOTES that list custom gates. ROADMAP B: custom gates built; remaining are workflows, presets and coverage delta.
- [ ] **Step 2: Skill docs.** Next to where they teach `check: { gate }` criteria, add one line: define the gate as a command in the repo's `.heph/config.yaml` (`gates: { buf: "buf lint" }`), and heph runs it on the unit that covers the criterion.
- [ ] **Step 3: Run** the skill-identity test, `bun test packages/cli/test/install.test.ts packages/core packages/engine/test/custom-gates.test.ts`, then compare `bun test packages/cli packages/engine packages/workers` failures with a baseline checkout of the starting commit (rerun flaky files alone) → no new failures. Run `bunx biome check --write packages` and `bunx tsc -b packages/core packages/workers packages/engine packages/cli`.
- [ ] **Step 4: Commit** `docs: custom command gates as built`.
