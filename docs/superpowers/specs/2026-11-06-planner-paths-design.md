# Planner paths: declared new files and a collapsed repo map (2026-11-06)

Sub-project A of `docs/ROADMAP.md` (planner quality), scoped to guessed paths.

## Problem

Stress test finding 6 (NOTES.md): of 113 literal non-test scope paths in 25 planner runs, 24 did not exist. Most were intended new files, but one guessed existing file recurred in 4 of 5 runs of one brief, and diff-scope would have failed it at execution. Two causes:

1. `scope_paths` (packages/core/src/gates/plan.ts) lists a missing file in an existing directory only as "new file ... for review". It cannot tell a new file from a misnamed existing one. Test tasks are exempt from the directory check entirely.
2. `repoMapFromFiles` (packages/workers/src/planner.ts) shows the first 200 tracked files per project, so on a large repo the planner sees a fraction of the paths.

## Decisions (2026-11-06)

- Tasks declare new files; an undeclared missing path fails the gate (chosen over warn-only and near-match heuristics).
- The repo map collapses directories instead of listing a flat prefix (chosen over keeping the flat list and over a planner file-listing tool, which can come later).
- Out of scope: rejecting over-wide test globs that lock unrelated existing tests (stress test finding 5). It is heuristic and nobody has hit it in real runs.

## 1. `creates` and the `scope_paths` gate

Schema (`packages/core/src/schemas/plan.ts`): `tasks[].creates`, an optional list of project-relative literal paths (no glob characters). Absent means empty, so existing plans and fixtures stay valid. Each `creates` path must also be covered by the task's `scope`.

`scope_paths` rules, for every task kind:

- A literal scope path that exists passes.
- A literal scope path that does not exist and is not in `creates` fails.
- A `creates` path that already exists fails: it is a misdeclared existing file.
- A wildcard scope that matches nothing passes only when its directory exists or the task is a test task, as today.
- A path leaving the project (absolute or `..`) fails, as today.

Test tasks lose their blanket exemption for literal paths: fixtures and new test files go in `creates`.

Failure evidence names the task and the path, and lists up to three existing files in the same directory with the closest names (edit distance). The planner loop already feeds gate evidence into the correction prompt, so the loop does not change.

The planner prompt (`packages/workers/prompts/planner.md`) gets one rule: list every file you expect to add in `creates`; scope paths that do not exist and are not in `creates` are rejected.

The diff-scope gate needs no change: new files are already allowed anywhere in scope.

Without a file list (`ctx.files` unset) the gate stays skipped, as today.

## 2. Collapsed repo map

`repoMapFromFiles` takes the Brief text (and, on a correction, the previous answer's failure evidence) and renders each project as a tree within about 200 lines:

- A directory is expanded to its full file list when the Brief mentions its path, one of its path segments, or a file name in it (case-insensitive). Ancestors show as headers. Root-level files are always listed.
- Every other directory renders as `dir/ (N files)`, at the shallowest level where the budget runs out.
- If expanded directories alone exceed the budget, directories matched by the Brief get it first; the rest are cut to their first files with `(N more files)`, and the map says the listing is partial.
- On a retry, any directory named in the previous failures (for example the `scope_paths` evidence) is also expanded, so a guess in a collapsed directory gets its real contents on the second try.

Small repos render in full, as today. No schema change: the map is a pure function of the file lists, the Brief text and the failure evidence.

## Testing

- Gate: a guessed existing file fails with close-name hints; a misdeclared `creates` path fails; a valid new file in `creates` passes; a test task with fixtures in `creates` passes; a wildcard in an existing directory still passes.
- Map: a large fixture repo stays within budget; a Brief mentioning `server/world/` expands it; a retry expands the directory named in failure evidence; a small repo renders in full.
- Planner prototype: rerun `plan-proto` on the stress-test fixtures and compare undeclared-path failures and first-try validity before and after. Success: first-try validity stays near the current ~97% on plannable Briefs, and the recurring guessed existing file is caught by the gate in 100% of runs that produce it.

## Not changed

Escalation behavior, the correction loop, diff-scope, test locking, and the ledger. `heph plan` and `Criterion.projects` stay in the roadmap.
