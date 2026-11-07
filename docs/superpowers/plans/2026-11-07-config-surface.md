# Config surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `heph run <run> --dry-run` (a read-only preview of a planned run), `heph schema` plus schemas and modelines written by `heph init`, and append-only role prompt files from `.heph/roles/`.

**Architecture:** Role prompt text is read by a new `packages/cli/src/role-files.ts` and passed into the planner and the OMP worker, which append it to the built-in prompt. `heph schema` and `heph init` generate JSON Schema from the zod definitions with `z.toJSONSchema`. The preview is a pure `previewRun` in the engine package (signals supplied by the caller), called by a new `Runtime.dryRun` through the host and a `--dry-run` flag on `run`.

**Tech Stack:** TypeScript on Bun, zod 4 (`z.toJSONSchema`), `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-07-config-surface-design.md`

## Global Constraints

- Role files are append-only: built-in prompt, then `## Project instructions`, then home text, then repo (or workspace, for the planner) text. No source markers in the prompt. A missing or empty file adds nothing; an unreadable file or one over 16 384 bytes is an error when the plan or build starts.
- `--dry-run` spawns no worker and writes no ledger event, worktree, lock or sandbox; it never waits out a rate limit. It is owner-only like the other run commands.
- The four schema names are exactly `home`, `workspace`, `repo`, `brief`; `heph init` writes `workspace`, `repo`, `brief` into `<workspace>/.heph/schemas/<name>.schema.json` on every run (even without `--force`); the generated YAML files keep the never-overwrite-without-`--force` rule, and each starts with the line `# yaml-language-server: $schema=<relative path>`.
- No ledger event, schema or projection changes; builds, resume, gates and routing are untouched.
- No attribution of any kind in commit messages (project CLAUDE.md overrides any harness reminder).
- `bun test <path>` per task. Baseline in the agent sandbox: about 70 tests in `packages/cli` and `packages/engine` and 18 in `packages/workers` (tools.test.ts, omp.test.ts) fail before this work (native-sandbox nesting, daemon, landing); `packages/cli` tsc reports 2 errors about unbuilt ui assets. Compare against a baseline checkout; do not chase them. Heavy suites time out under load: judge flaky failures by running the file alone.

## Review Focus

- A role file that is a directory, unreadable, or over 16 KB: a clear error before any worker spawns, never a silently shorter prompt. (Task 1)
- `heph init` run twice, and in a workspace where the repo is the workspace directory: modeline paths resolve to files that exist; YAML untouched on the second run, schemas refreshed. (Task 2)
- `--dry-run` on a run with no plan, on an already built or failed run, and on a run owned by another node. (Task 3)
- A plan where `parallel` is 1 versus 3, and where a test unit locks later units: waves and `locked_by` agree with what the real scheduler would do. (Task 3)
- `heph schema` with no name or a bad name; `--json` envelope for all three new surfaces. (Tasks 2, 3)

---

### Task 1: Role prompt files

**Files:**
- Create: `packages/cli/src/role-files.ts`
- Modify: `packages/workers/src/prompt.ts` (`loadRolePrompt`, ~line 16), `packages/workers/src/omp.ts` (`createOmpWorker` options and the `loadRolePrompt(input.role)` call ~line 217), `packages/workers/src/planner.ts` (`PlannerInput`, `renderPlannerPrompt`)
- Modify: `packages/cli/src/runtime.ts` (worker creation ~line 181; the planner call ~line 440), `packages/cli/src/main.ts` (`config explain`, ~line 662)
- Test: `packages/cli/test/role-files.test.ts`, `packages/workers/test/prompt.test.ts`, `packages/workers/test/planner-prompt.test.ts`

**Interfaces:**
- Produces:
  - `loadRolePrompt(role: string, instructions?: string): Promise<string>`: the built-in prompt; with non-empty trimmed `instructions`, followed by `"\n\n## Project instructions\n\n" + instructions`.
  - `createOmpWorker({ ..., roleInstructions?: (role: string, project: string) => string | undefined })`; the worker calls it with `input.role` and `input.brief.task.project` and passes the result to `loadRolePrompt`.
  - `PlannerInput.projectInstructions?: string`; `renderPlannerPrompt` appends `"\n\n## Project instructions\n\n" + text` after the rendered template when set and non-empty.
  - In `role-files.ts`: `export const ROLE_FILE_LIMIT = 16 * 1024`; `export type RoleFile = { role: string; path: string; layer: "home" | "repo" | "workspace" }`; `roleInstructions(o: { home: string; dir: string; dirLayer: "repo" | "workspace"; role: string }): string | undefined` (home file text, then the `dir` file text, joined by a blank line; undefined when both are missing or empty; throws `Error("role file <path> is over 16 KB")` or `Error("can't read role file <path>: <message>")`); `listRoleFiles(o: { home: string; workspaceDir: string; repoDirs: string[] }): RoleFile[]` (every existing, non-empty `<home>/roles/<role>.md`, `<workspaceDir>/.heph/roles/planner.md` and `<repoDir>/.heph/roles/<role>.md` for the worker roles `test_author`, `implementer`, `documenter`, with no duplicate paths, errors as above). Files live at `<dir>/roles/<role>.md` under `home` and `<dir>/.heph/roles/<role>.md` under a workspace or repo directory.
  - `config explain` output (`LoadedConfig & { roles: RoleFile[] }` in `--json`) gains lines `roles.<role> = <path>  (<layer>)` after the config lines.

- [ ] **Step 1: Write failing tests.**
  - `role-files.test.ts` (temp dirs): home and repo files both present give `home text\n\nrepo text`; only one present gives that text; empty/whitespace-only file gives undefined; neither gives undefined; a directory named `implementer.md` throws a `can't read role file` error; a 16 385-byte file throws `is over 16 KB`; `listRoleFiles` returns the right `{role, path, layer}` entries without duplicates when the workspace directory is also the only repo directory, and `[]` when no role files exist.
  - `prompt.test.ts`: `loadRolePrompt("implementer")` equals the existing built-in text (unchanged); `loadRolePrompt("implementer", "Use tabs.")` equals built-in + `"\n\n## Project instructions\n\nUse tabs."`; empty `"  "` leaves it unchanged; an unknown role still throws.
  - `planner-prompt.test.ts`: `renderPlannerPrompt(template, input)` without `projectInstructions` equals today's output; with it, ends with `## Project instructions\n\n<text>`.
  - A `config explain` test in `packages/cli/test/config.test.ts` (see how existing explain tests build a workspace): with a home role file and a repo role file, the output has the two `roles.…` lines with the right layers, and none without files.
- [ ] **Step 2: Run** `bun test packages/cli/test/role-files.test.ts packages/workers/test/prompt.test.ts packages/workers/test/planner-prompt.test.ts packages/cli/test/config.test.ts` → the new tests fail.
- [ ] **Step 3: Implement** the interfaces. In `runtime.ts` the worker's `roleInstructions` resolves the unit's repo directory the way the runtime already finds a project's checkout (see `sandboxFor`) and calls `roleInstructions({ home: opts.home, dir: <repo dir>, dirLayer: "repo", role })`; the planner call passes `projectInstructions: roleInstructions({ home: opts.home, dir: workspaceRoot, dirLayer: "workspace", role: "planner" })`. A role-file error propagates as the plan or build error.
- [ ] **Step 4: Run** the same tests, then `bun test packages/workers/test/planner.test.ts packages/cli/test/config.test.ts` and `bunx tsc -b packages/workers packages/cli` → pass.
- [ ] **Step 5: Commit** `workers, cli: append-only role prompt files from .heph/roles`.

---

### Task 2: `heph schema` and the schemas `heph init` writes

**Files:**
- Create: `packages/cli/src/schema.ts`
- Modify: `packages/cli/src/main.ts` (new `schema` command in `COMMANDS`), `packages/cli/src/init.ts` (`initWorkspace`, `InitResult`, ~line 114)
- Test: `packages/cli/test/schema.test.ts`, `packages/cli/test/init.test.ts`

**Interfaces:**
- Produces: in `schema.ts`: `export const SCHEMA_NAMES = ["home", "workspace", "repo", "brief"] as const`; `export type SchemaName = (typeof SCHEMA_NAMES)[number]`; `export function schemaFor(name: SchemaName): Record<string, unknown>` (the zod schemas `HomeConfigLayer`, `WorkspaceConfig`, `RepoConfigLayer`, `Brief` from `@hephaestus/core`, through `z.toJSONSchema`); `export function isSchemaName(s: string): s is SchemaName`.
- `heph schema <name>`: human output is the schema as pretty JSON; `--json` wraps it in the usual envelope; usage `schema <home|workspace|repo|brief>`; no name or an unknown name is an error `unknown schema "x"; one of: home, workspace, repo, brief`.
- `initWorkspace` additionally writes `<workspaceDir>/.heph/schemas/{workspace,repo,brief}.schema.json` on every call and returns them as `schemas: string[]` in `InitResult`; each generated YAML file's content becomes `# yaml-language-server: $schema=<path>\n` + the existing header + the data, where `<path>` is the POSIX relative path from the YAML file's directory to the schema file (`schemas/workspace.schema.json` for `workspace.yaml`; `schemas/repo.schema.json` or `../../.heph/schemas/repo.schema.json` style for repo configs). The overwrite rule (`--force`) applies to the YAML files only. The init command's human output gains one line naming the schema directory and saying it may be committed or ignored.

- [ ] **Step 1: Write failing tests.** `schema.test.ts`: each name returns an object with `type: "object"` and `properties`; `repo` has `properties.routing` and, under it, role routes that accept `top` and `fallback` keys (assert the keys exist in the generated JSON by walking `properties.routing.additionalProperties.properties`); `workspace` has `properties.repos`; `brief` has `properties.acceptance`; `JSON.parse(JSON.stringify(schemaFor(n)))` equals it; `isSchemaName`. CLI: `heph schema repo --json` returns the envelope with `data.properties`; `heph schema nope` fails with the exact message; no name fails the same way. `init.test.ts` (extend): after `initWorkspace` the three schema files exist and parse as JSON; the first line of `workspace.yaml` and of each repo `config.yaml` is the modeline and the path in it resolves (from the YAML file's directory) to an existing file; a second `initWorkspace(dir, { force: false })` throws for the existing YAML as before; with `{ force: true }` it rewrites both; deleting a schema file and re-running with `force: true` recreates it; and with the repo equal to the workspace directory the repo modeline is `schemas/repo.schema.json`. Update existing init tests that assert the exact start of the generated file.
- [ ] **Step 2: Run** `bun test packages/cli/test/schema.test.ts packages/cli/test/init.test.ts` → the new tests fail.
- [ ] **Step 3: Implement.** Schemas are written before the YAML files so a refused overwrite (`--force` missing) still refreshes them only when the YAML check passes: write nothing if the YAML check throws (the existing behavior), otherwise write everything.
- [ ] **Step 4: Run** the two test files, `bun test packages/cli/test/usage.test.ts packages/cli/test/config.test.ts`, and `bunx tsc -b packages/cli` → pass.
- [ ] **Step 5: Commit** `cli: heph schema, and heph init writes schemas and modelines`.

---

### Task 3: `heph run <run> --dry-run`

**Files:**
- Create: `packages/engine/src/preview.ts`
- Modify: `packages/engine/src/index.ts` (export), `packages/cli/src/runtime.ts` (`dryRun`, next to `planShow` ~line 600), `packages/cli/src/host.ts` (add `"dryRun"` to `OWNER_ONLY` ~line 30), `packages/cli/src/main.ts` (`Flags.dryRun`, the `dry-run` option, `remote().dryRun`, the `run` command ~line 413)
- Test: `packages/engine/test/preview.test.ts`, `packages/cli/test/dry-run.test.ts`

**Interfaces:**
- Consumes: `routeTier`/`RouteSignals` (core), `resolveRoute`, `fallbackRoute`, `ROLE_BY_KIND`, `EngineConfig` (engine config), `readyUnits`, `deriveEdges`, `topoOrder`, `reachability` (core graph), `routeSignals` (engine route.ts), `listRoleFiles` (Task 1).
- Produces, in `preview.ts`:
  - `export type PreviewUnit = { id: string; project: string; kind: TaskKind; lane: Lane; planner_tier: Complexity; start_tier: Complexity; score: number; reasons: string[]; role: string; route: Route; top?: Route; fallback?: Route; attempt_timeout_ms?: number; locked_by: string[]; gates: string[] }`
  - `export type Preview = { dry_run: true; run_id: string; parallel: number; waves: string[][]; units: PreviewUnit[]; prompts: RoleFile-like entries (role, path, layer) }`
  - `export async function previewRun(o: { runId: string; plan: Plan; workspace: Workspace; config: EngineConfig; projectGates: ProjectGates; signals: (t: Task) => Promise<RouteSignals>; prompts?: Preview["prompts"] }): Promise<Preview>`:
    - `units` in `topoOrder` of `deriveEdges(plan.tasks)`; per unit `routeTier(task, await signals(task))` gives `start_tier`/`score`/`reasons`; `role = ROLE_BY_KIND[kind]`; `route = resolveRoute(config, role, start_tier)`; `top = config.routing[role]?.top` and `fallback = fallbackRoute(config, role)` set only when configured; `attempt_timeout_ms = config.attemptTimeoutByTier?.[start_tier] ?? config.attemptTimeoutMs` (omitted when both unset); `locked_by` = ids of `test` tasks of the same project with a path to the unit (`reachability`), `gates = projectGates[project] ?? []`.
    - `waves`: starting from nothing accepted, repeatedly take `readyUnits(plan, workspace, { accepted, inFlight: new Set(), scopeOf: (id) => task.scope }, config.parallel)`, record the wave, mark them accepted, stop when a wave is empty; units never reached (a stuck plan) are not listed in any wave.
- Runtime: `Runtime.dryRun(runId: string): Promise<Preview>` throws `run <id> has no finished plan (heph plan revise <id>)` when there is none and `run <id> is <status>` for a terminal run; it reads the latest plan, builds `signals` with `routeSignals` against the repo's target branch tip (as landing resolves targets; fall back to `HEAD`), and creates no ledger event, worktree or lock.
- CLI: `run` with `--dry-run` calls `rt.dryRun(id)` and returns before `untilApproved`/`build`; `--json` is the envelope with the `Preview` as `data`; human output is the line `dry run of <run>: <n> units, up to <parallel> in parallel (router sizes are estimates: files are read from the target branch)`, then per wave `wave <k>:` and one line per unit `  <id> <project> <kind> <lane>  <role> -> <model>[ effort] (start <tier>, planner <tier>; <reasons joined by ", ">)[; top <model>][; fallback <model>][; locked by <ids>]`, then a `prompts:` list of `<role>: <path> (<layer>)` when any.

- [ ] **Step 1: Write failing tests.**
  - `preview.test.ts` (use `crossRepoPlan()`/`config` from `packages/engine/test/workspace.ts` and `threeRepos` only for the workspace object; `signals` is a stub returning fixed `RouteSignals`): units come out in build order `P1, S1, S2`; at `parallel: 1` waves are `[["P1"],["S1"],["S2"]]`; a plan with two independent units in different projects at `parallel: 2` puts them in one wave; `S2.locked_by` equals `["S1"]` and `P1.locked_by` is `[]`; routes come from `config.routing` (give implementer a `top` and a `fallback` and see them on implement units only; a role without them has neither key); a stub `signals` that returns a small task gives `start_tier: "trivial"` with its reasons; `attempt_timeout_ms` follows `attemptTimeoutByTier` then `attemptTimeoutMs`, and is omitted when neither is set; `gates` come from `projectGates`; `prompts` pass through.
  - `dry-run.test.ts` (copy the set-up of `packages/cli/test/lifecycle.test.ts`: scripted planner and worker from `fixtures/deps.ts`, a temp home and workspace, the `heph([...])` helper): after `new` (plan ready), `heph run R1 --dry-run --json` succeeds with `data.dry_run === true`, `data.units.length === 2`, and `data.waves` equal to `[["T1"],["T2"]]`; the ledger's event count for R1 is identical before and after the call; running it twice gives identical `data`; the plain-text form contains the `dry run of R1:` line; on a run with no finished plan it fails with the `has no finished plan` message; on a cancelled run it fails with `is failed`; it works without approving the plan; it does not create a lock file under `$HEPH_HOME/locks`.
- [ ] **Step 2: Run** `bun test packages/engine/test/preview.test.ts packages/cli/test/dry-run.test.ts` → fail (module missing).
- [ ] **Step 3: Implement** `previewRun`, `Runtime.dryRun`, the host entry and the CLI flag as specified; `--dry-run` is a boolean option like `--now`.
- [ ] **Step 4: Run** both test files, `bun test packages/engine/test/engine.test.ts packages/cli/test/usage.test.ts`, and `bunx tsc -b packages/engine packages/cli` → pass apart from the baseline failures.
- [ ] **Step 5: Commit** `engine, cli: heph run --dry-run previews a planned run`.

---

### Task 4: Docs and the chat-host skill

**Files:**
- Modify: `docs/SPEC.md` (§5 Ergonomics bullets, §16 CLI list), `docs/NOTES.md` (new section "Config surface (2026-11-07)"), `docs/ROADMAP.md` (sub-project B), the Claude Code skill and its identical Codex copy (`integrations/claude/skills/heph/SKILL.md`, `integrations/codex/AGENTS.md`; a test keeps them identical, so change both the same way)
- Test: the existing skill-identity test (find it with `grep -rn "SKILL.md" packages/cli/test`)

- [ ] **Step 1: Update the docs.** SPEC §5 Ergonomics: mark built `--dry-run` (as `heph run --dry-run`), schema-validated config with editor autocomplete (`heph schema`, `heph init` writes schemas and modelines), prompts as files (append-only `.heph/roles/<role>.md`, home then repo or workspace); presets stay unbuilt; workflows stay unbuilt. §16 CLI list: add `heph run <run> --dry-run` and `heph schema <home|workspace|repo|brief>`. NOTES "Config surface (2026-11-07)": what was built, the decisions (append-only, schemas written on every init, estimates in the preview), the 16 KB limit, that files are read at each worker spawn so a mid-run edit applies to later attempts (the `prompt_hash` shows it), and what is deferred (presets, workflows, a prompt dump command, a home-config schema in the installer, custom gates). ROADMAP B: dry-run, JSON Schema and role prompt overrides built; presets, workflows, custom gates and the extra gates remain.
- [ ] **Step 2: Skill docs.** In the skill and its Codex copy add one line next to where they teach `heph run`: `heph run <run> --dry-run` previews the planned build (models, tiers, parallel waves) without spending tokens, useful before `heph run` on a large plan.
- [ ] **Step 3: Run** the skill-identity test, `bun test packages/cli/test/install.test.ts`, then compare `bun test packages/cli packages/engine packages/workers` failures with a baseline checkout of the starting commit (run flaky files alone) → no new failures. Run `bunx biome check --write packages` and `bunx tsc -b packages/core packages/workers packages/engine packages/cli`.
- [ ] **Step 4: Commit** `docs: config surface as built`.
