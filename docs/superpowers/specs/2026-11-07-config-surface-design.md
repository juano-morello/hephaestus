# Config surface: `heph run --dry-run`, JSON Schema, role prompt files (2026-11-07)

Sub-project B (authoring surface), first half, of `docs/ROADMAP.md`. The other half (custom gates from `.heph/gates/` and the extra gates) waits for the gate-quality track to merge, since both edit the engine's gate code. Workflows and presets are deliberately not part of this.

## Problem

Checked in the source on 2026-11-07:

- `--dry-run`, presets (`extends:`), `.heph/roles/<role>.md` overrides and workflow files do not exist (SPEC §5 Ergonomics lists them). Role prompts are embedded in `packages/workers/prompts`.
- There is no way to see what a build will do before it spends tokens: which model each unit gets, the router's start tier, what runs in parallel, which test units lock it.
- Config files have no editor autocomplete: nothing generates a JSON Schema for them, although the zod schemas (strict) exist.
- The run flow (plan, build, merge) is hard-coded; a workflow file would mean configurable node types, a separate project with no current need.

## Decisions (2026-11-07)

- Scope: dry-run, JSON Schema, role prompt overrides (chosen over adding presets, and over dry-run plus schema only). Presets and workflows are deferred.
- Dry-run shape: a `--dry-run` flag on `heph run` (chosen over `heph plan show --resolved` and over a new `heph plan check` command; `plan-proto` still covers evaluating a plan file by hand).
- Schemas: a `heph schema` command, and `heph init` writes schemas plus a YAML-language-server modeline (chosen over a command only and over committed schemas with a hosted URL).
- Role prompts: append-only (chosen over replace, and over both). The built-in output contract can never be dropped by a project file.
- Out of scope: a `heph prompt <role>` dump command, a reviewer role prompt (none exists), per-task prompts, a schema for the home config in `heph init`/the installer (`heph schema home` still prints it), changing `.gitignore`.

## 1. `heph run <run> --dry-run`

- For a planned run (approved or not) it prints what a build would do and changes nothing: no worker, no ledger events, no worktree, no run lock, no wait on a rate limit. It goes through the host, so a run owned by another node is answered by its owner (owner-only, like the other run commands).
- Per unit, in build order: id, project, kind, lane; the planner's tier and the router's start tier with score and reasons; the role and the resolved route (model, effort), the `top` route and the fallback route when configured; the attempt timeout; the test units whose files lock it; the gates configured for its project.
- A section of parallel waves: groups of units that could run together at `limits.parallel`, simulated with the scheduler's ready-set logic (`readyUnits`), assuming every unit is accepted.
- Estimates are labelled: the router's file counts come from the target branch tip, because the real build reads them after earlier units are accepted.
- It lists the role prompt files in effect (section 3).
- `--json` gives `{ dry_run: true, run_id, parallel, waves, units: [...], prompts }` in the usual versioned envelope; the human form is a short table per wave. A run with no plan yet is a clear error.
- Code: a pure `previewRun(...)` in the engine package, called by a new `Runtime.dryRun(runId)`; the `run` command gets a `--dry-run` flag and dispatches to it before the build path.

## 2. `heph schema` and the schemas `heph init` writes

- `heph schema <home|workspace|repo|brief>` prints the JSON Schema generated from the zod definitions with `z.toJSONSchema`: `home` is `~/.heph/config.yaml` (`HomeConfigLayer`), `workspace` is `.heph/workspace.yaml` (`WorkspaceConfig`), `repo` is `<repo>/.heph/config.yaml` (`RepoConfigLayer`), `brief` is a Brief file (`Brief`). The human form prints the schema JSON; `--json` wraps it in the envelope. An unknown name is a usage error listing the four. The schemas are strict, so `additionalProperties: false` flags unknown keys.
- `heph init` writes the `workspace`, `repo` and `brief` schemas to `<workspace>/.heph/schemas/<name>.schema.json`. Each generated YAML file gets a first line `# yaml-language-server: $schema=<relative path>`: `schemas/workspace.schema.json` in `workspace.yaml`, and the relative path to `.heph/schemas/repo.schema.json` in each repo `config.yaml`.
- The schemas are derived files: `heph init` rewrites them every time it runs, even without `--force`, so they follow the installed binary; the YAML files keep the rule of never being overwritten without `--force`. Init prints one line that the schemas exist and can be committed or ignored.

## 3. Role prompt files (append-only)

- Worker roles (`test_author`, `implementer`, `documenter`) read `~/.heph/roles/<role>.md` then `<repo>/.heph/roles/<role>.md` (the repo holding the unit's project); the planner reads `~/.heph/roles/planner.md` then `<workspace>/.heph/roles/planner.md`. Both layers apply, home first. A missing or empty file adds nothing; an unreadable file, or one over 16 KB, is an error when the plan or build starts.
- Applied as the built-in prompt, then `## Project instructions`, then the home text, then the repo text. No source markers in the prompt.
- Plumbing: `loadRolePrompt(role, instructions?)` and `createOmpWorker({ ..., roleInstructions })` take the text for a role and project; `PlannerInput` gets `projectInstructions?: string`; a new `packages/cli/src/role-files.ts` reads and lists the files; the CLI runtime passes the text into the worker and the planner call.
- Hashing: attempts already record a `prompt_hash` of the final system prompt and the planner's is computed from its rendered prompt, so an override changes the hash with no new field. Files are read when each worker is spawned, so an edit mid-run applies to later attempts, and the hash shows it.
- Visibility: `heph config explain` gets a `roles` section listing every role file in effect and its layer; `--dry-run` lists the same files.

## Testing

- Dry-run: the preview function with a fixture plan and config (routes, `top`, fallback, waves at parallel 1 and 2, locked-by, estimated start tiers); `--dry-run` writes no ledger events; the `--json` shape; a run with no plan errors clearly.
- Schema: each of the four schemas generates and is valid JSON; the repo schema contains `routing`, `limits` and the `top` and `fallback` route keys; a bad name fails with the list; `heph init` writes the three schemas, puts the modeline first in each generated YAML pointing at a file that exists, and a second `heph init` leaves the YAML alone but refreshes the schemas.
- Role prompts: layer order and append placement; the built-in prompt unchanged with no files (the existing prompt tests); missing and empty files add nothing; unreadable and oversized files are errors; the worker's and the planner's prompts contain the appended text and the hash changes; `config explain` and the dry-run list the files.

## Not changed

The build and resume paths, ledger events and projections, the plan and brief gates, the router and ladder, and the installer.
