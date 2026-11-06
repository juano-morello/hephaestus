# Planner paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Planned tasks declare the files they add (`creates`), the `scope_paths` gate fails undeclared missing paths with close-name hints, and the planner sees a collapsed repo map that expands the directories the Brief (or the last failure) points at.

**Architecture:** `creates` is an optional field on `Task` (core schema). `scopePaths` (core gate) is rewritten around it and uses a small `closestNames` helper. `repoMapFromFiles` (workers) becomes a budgeted directory tree driven by the Brief text and failure evidence; the CLI planner loop passes both in. The planner prompt documents the rule.

**Tech Stack:** TypeScript on Bun, zod, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-06-planner-paths-design.md`

## Global Constraints

- Plans without `creates` stay valid (the field is optional; absent means empty).
- `creates` entries are project-relative literal paths: no `*`, `?`, `[`, `{`.
- Without a file list (`ctx.files` unset) `scope_paths` stays skipped.
- A map for a project with 200 or fewer files renders exactly as today (flat list).
- Map budget stays about 200 lines per project (`maxLines`, default 200).
- No attribution of any kind in commit messages (project CLAUDE.md overrides any harness reminder).
- Tests run with `bun test <path>`; the full suite must pass before the last commit.

## Review Focus

- A `creates` entry or scope path written `./inventory/cap.go`: expect a clear failure telling the planner to use project-relative paths without `./`, not a silent pass. (Task 1)
- A project with no tracked files yet: every literal path must be in `creates`, and then the plan passes. (Task 1)
- A glob character in `creates`: rejected by the schema, which the loop already reports as `plan_schema`. (Task 1)
- A Brief with regex metacharacters or very long text: matching uses substring checks and never throws. (Task 2)
- One directory with more than 200 files that all match the Brief: the map stays within budget plus its notice lines and says it is partial. (Task 2)

---

### Task 1: `creates` field and the `scope_paths` gate

**Files:**
- Modify: `packages/core/src/schemas/plan.ts` (the `Task` object)
- Create: `packages/core/src/gates/names.ts`
- Modify: `packages/core/src/gates/plan.ts` (`scopePaths`, lines ~271-311)
- Test: `packages/core/test/plan-gates.test.ts` (the `scope_paths` describe, ~479), `packages/core/test/schemas.test.ts`, new `packages/core/test/names.test.ts`

**Interfaces:**
- Produces: `Task.creates?: string[]`; `closestNames(target: string, existing: string[], limit?: number): string[]` exported from `names.ts` (default limit 3): existing files in the same directory as `target`, ordered by edit distance between base names, ties by name.
- Produces the evidence formats Task 2 parses (tokens containing `/`):
  - `<id>: <path> does not exist and is not in creates (closest existing: a, b, c)` (the parenthesis is omitted when the directory has no files)
  - `<id>: <path> is in creates but already exists`
  - `<id>: <path> is in creates but outside the task scope`
  - `<id>: <path> is not project-relative; drop the leading ./`
  - existing messages for a missing directory and for paths leaving the project are unchanged
- Fail reason becomes `scopes point at paths that do not exist or are not declared in creates`.

- [ ] **Step 1: Write failing tests.**
  - `names.test.ts`: `closestNames("inventory/cap.go", ["inventory/stack.go", "inventory/cap_test.go", "other/cap.go"])` returns `["inventory/cap_test.go", "inventory/stack.go"]` (same directory only); empty list returns `[]`; `limit` is honored.
  - `schemas.test.ts`: a Task with `creates: ["a/b.go"]` parses; absent `creates` parses; `creates: ["a/*.go"]` fails.
  - `plan-gates.test.ts` `scope_paths`, with `files = { server: ["inventory/stack.go", "inventory/stack_test.go", "go.mod"] }`:
    - `scope: ["inventory/cap.go"]` without `creates` fails with evidence `T1: inventory/cap.go does not exist and is not in creates (closest existing: inventory/stack.go, inventory/stack_test.go)`.
    - The same with `creates: ["inventory/cap.go"]` passes with evidence `T1: new file inventory/cap.go`.
    - `creates: ["inventory/stack.go"]` fails with `T1: inventory/stack.go is in creates but already exists`.
    - `creates: ["inventory/cap.go"]` with `scope: ["inventory/stack.go"]` fails with `... is in creates but outside the task scope`.
    - A `kind: "test"` task with literal `inventory/new_test.go` and no `creates` fails; with `creates` it passes; a test-task wildcard `inventory/testdata/*.ini` still passes.
    - `scope: ["./inventory/cap.go"]` and `creates: ["./inventory/cap.go"]` fail with the not-project-relative message.
    - `ctx({ files: { server: [] } })` with `scope: ["main.go"], creates: ["main.go"]` passes.
  - Update the existing `scope_paths` tests that now need `creates` (new file in an existing directory, glob-under-top-level case with `godot/tests/auth_test.gd`, the missing-directory test's reason string).

- [ ] **Step 2: Run and confirm failures.** `bun test packages/core/test/plan-gates.test.ts packages/core/test/schemas.test.ts packages/core/test/names.test.ts` → the new tests fail, nothing else.

- [ ] **Step 3: Implement.** Add `creates: z.array(z.string().min(1).refine((p) => !/[*?[{]/.test(p), "creates takes literal paths, no globs")).optional()` to `Task`. Implement `closestNames` with a plain Levenshtein on base names. Rewrite the literal-path branch of `scopePaths` per the spec's rules: a literal scope path passes when it exists, or is in `creates`; otherwise it fails (the missing-directory message is kept when the directory does not exist, the undeclared message when it does). Wildcard handling, `..`/absolute handling and the skip-without-files behavior stay as they are. Reject a leading `./` in scope or creates entries.

- [ ] **Step 4: Run `bun test packages/core` and fix fixtures.** Plans in `packages/core/test/eval-fixtures`, `packages/core/test/helpers.ts` users and `packages/workers/test/planner-fixtures.ts` that name new literal files now need `creates`; add them. Expected: all pass.

- [ ] **Step 5: Commit** `core: tasks declare new files in creates; scope_paths fails undeclared missing paths`.

---

### Task 2: Collapsed repo map

**Files:**
- Modify: `packages/workers/src/planner.ts` (`repoMapFromFiles`, ~line 89; add `pathsInEvidence`)
- Modify: `packages/cli/src/runtime.ts:446`
- Test: `packages/workers/test/planner.test.ts` (the `repoMapFromFiles` describe, ~196)

**Interfaces:**
- Produces: `repoMapFromFiles(files: Record<string, string[]>, opts?: { brief?: string; focus?: string[]; maxLines?: number }): string`. The old second positional `maxLines` argument is replaced by `opts.maxLines` (default 200).
- Produces: `pathsInEvidence(feedback: GateResult[]): string[]`: every whitespace-delimited token in the evidence strings that contains a `/`, with trailing punctuation (`:,)`) stripped.
- Behavior of `repoMapFromFiles` per project:
  - 200 or fewer files (or `(no tracked files)`): unchanged output.
  - Otherwise a tree: root-level files always listed. A directory is expanded to its full file list when `brief` (case-insensitive substring) contains its path, one of its path segments of 3+ characters, or the name of a file in it, or when a `focus` path starts with the directory path. Every other directory renders as `dir/ (N files)`, at the shallowest level where the remaining budget runs out (spend leftover budget by expanding collapsed directories one level at a time, in path order). Brief-matched and focus directories get budget first; one that does not fit is cut to its first files plus `(N more files)`. A partial listing ends with the line `(listing is partial: dir/ (N files) entries are collapsed)`.

- [ ] **Step 1: Write failing tests** in the `repoMapFromFiles` describe (replace the old 5-file/3-line test): small project renders flat exactly as before; a fixture of 400 files across `server/world/*`, `server/net/*`, `client/ui/*` with `brief: "fix server/world/boot.go"` expands `server/world/` and collapses `net/` and `ui/` with counts, and total lines per project <= `maxLines + 3`; a retry with `focus: ["server/net/conn.go"]` and an empty brief expands `server/net/`; a brief with regex metacharacters (`"a.*(b"`) does not throw; one directory of 500 matching files stays within budget and ends with the partial line; `pathsInEvidence([{gate: "scope_paths", verdict: "fail", reason: "x", evidence: ["T1: inventory/cap.go does not exist and is not in creates (closest existing: inventory/stack.go)"]}])` returns `["inventory/cap.go", "inventory/stack.go"]`.

- [ ] **Step 2: Run** `bun test packages/workers/test/planner.test.ts` → the new tests fail.

- [ ] **Step 3: Implement** both functions in `planner.ts` as specified above; build the tree from the path strings once per project; export `pathsInEvidence`.

- [ ] **Step 4: Wire the loop.** At `runtime.ts:446` call `repoMapFromFiles(files, { brief: JSON.stringify(brief), focus: feedback ? pathsInEvidence(feedback) : [] })`, importing `pathsInEvidence` through the same `workers()` accessor `repoMapFromFiles` uses.

- [ ] **Step 5: Run** `bun test packages/workers packages/cli` → pass.

- [ ] **Step 6: Commit** `workers: collapsed repo map expands directories the Brief and the last failure name`.

---

### Task 3: Prompt rule and docs

**Files:**
- Modify: `packages/workers/prompts/planner.md` (schema block near line 33, rule 9 near line 114, worked example ~193-206)
- Modify: `docs/SPEC.md` (§8 Plan schema), `docs/NOTES.md` (move the two deferred items out of "Deferred", add a short "Planner paths (2026-11-06)" section)
- Test: `packages/workers/test/planner-prompt.test.ts`

**Interfaces:** Consumes `Task.creates` from Task 1.

- [ ] **Step 1: Write a failing test**: the rendered prompt contains `creates` in the schema block and the rule sentence `scope paths that do not exist and are not in creates are rejected`.
- [ ] **Step 2: Run** `bun test packages/workers/test/planner-prompt.test.ts` → fails.
- [ ] **Step 3: Edit the prompt**: add `creates?: string[],  // every file this task adds; literal paths, inside scope` to the schema block; add to rule 9 "List every file you expect to add in `creates`; scope paths that do not exist and are not in `creates` are rejected."; add `creates` to the worked example's tasks that add files (the test file and any new implementation file).
- [ ] **Step 4: Update SPEC §8 and NOTES** (the two deferred bullets about the file-list gate and generated repo maps become "built 2026-11-06"; record what is still out of scope: over-wide test globs).
- [ ] **Step 5: Run** `bun test` (whole suite, outside the agent sandbox if native-sandbox tests are included) → pass.
- [ ] **Step 6: Commit** `planner prompt and docs: creates`.

---

### Task 4: Measure on the stress-test fixtures (live model; run only with the owner's go-ahead)

**Files:** `packages/workers/scripts/plan-proto.ts` (existing, run as is), `docs/NOTES.md` (results).

- [ ] **Step 1: Run** `plan-proto` on the stress-test fixture set with `--workspace-root` and `--correct`, as the 2026-11-03 stress test did, once on the previous commit (`git stash` is not needed: check out `dc2adf2` in a temp worktree) and once on this branch.
- [ ] **Step 2: Record in NOTES** first-try and second-try validity, and the count of runs producing an undeclared missing path. Success: first-try validity stays near 97% on plannable Briefs and every run that guesses an existing file is failed by `scope_paths`.
- [ ] **Step 3: Commit** `notes: planner paths measurement`.
