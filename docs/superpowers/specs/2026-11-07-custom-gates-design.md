# Custom command gates and execution-time criterion checks (2026-11-07)

Sub-project B (authoring surface), second half, of `docs/ROADMAP.md`. Workflows and presets stay deferred.

## Problem

Checked in the source on 2026-11-07:

- `projects.<p>.gates: [buf]` is a list of names that feeds only the plan-time checks (`criteria_covered`, the brief gate, the planner's project-gates list). At execution the engine runs the six built-ins (`diff_scope`, `locked_paths`, `touched_vs_diff`, `tests`, `typecheck`, `lint`) and nothing else: no code looks up a gate by its configured name or checks a criterion's `check: { gate }`. A criterion such as "buf passes" is declared covered and never verified.
- SPEC §11 promises custom gates as TS files in `.heph/gates/`. Running repo-supplied code inside the engine process would give it the engine's privileges (git push, merge, secrets), against SPEC §12 ("gates run in the same sandbox as the worker").
- Of the other listed extra gates, project-imports-headless (Godot) is just a command; coverage delta needs per-stack output parsing plus a baseline run.

## Decisions (2026-11-07)

- Custom gates are command gates run in the sandbox (chosen over TS gate files, and over only wiring the existing names). TS gate files are deferred until there is a safe way to run them.
- Config shape: `gates` becomes a map of name to command (string or `{ command, timeout_ms?, always? }`); the old list of names still loads as "declared, no command" (chosen over a separate `gate_commands` key and over a separate gates file).
- Selection: a gate runs on the units that cover a criterion naming it, plus `always: true` gates on every unit of the project (chosen over always-on for all gates, and over lane-based).
- Out of scope: TS gate files, coverage delta, `{files}` in custom gate commands, custom gates in the join and landing re-gates, lane-based gates, a Godot stack in `heph init`.

## 1. Config shape

- `ProjectSettings.gates` (packages/core/src/schemas/config.ts) accepts the old list of names or a map of name to a spec. A spec is a command string or `{ command, timeout_ms?, always? }` (strict). `always` without a `command` is a config error with the exact line. A name from the old list is "declared, no command".
- The loader normalizes every layer: the resolved `projects.<p>.gates` is always a map `name -> { command?, timeout_ms?, always }`. List names become `{ always: false }`. The plan-time `ProjectGates` are the built-ins plus those keys, as today.
- A custom gate cannot reuse a built-in name (`tests`, `typecheck`, `lint`, `diff_scope`, `locked_paths`, `touched_vs_diff`): a config error naming the key.
- Each gate entry replaces as a whole across layers (the loader's `isAtomic` rule, as for routes), so a later layer can redefine `buf` without inheriting a stale timeout.
- `heph config explain` shows `projects.server.gates.buf.command = "..."  (file)`; `heph schema repo` follows the zod schema automatically.

## 2. Execution

- `localRunner` (packages/engine/src/runner.ts) takes `extraGates?: (task: Task) => UnitGate[]`; each attempt runs the built-ins first, then the task's extra gates. The runtime builds it from the resolved config and the Brief through a pure `customGatesFor(task, criteria, projectGates)` in the engine package:
  - a gate runs for a task when some Brief criterion has `check: { gate: <name> }` and the task's `covers` includes that criterion's id, or when the gate is `always: true` in the task's project;
  - a criterion-named gate is selected for any covering task; if the task's project has no entry or no command for it, the gate fails loudly (below), which also covers config that changed after planning; `always` gates are only those marked `always` in the task's own project;
  - test units are skipped for criterion-named gates (the plan gate forbids them from covering such a criterion); `always` gates run on every unit including test units.
- One gate runs through `namedCommandGate(name, spec)`: the same sandbox, `exit N` line and tail-of-output evidence as `tests`; `timeout_ms` from the spec or else the usual gate timeout; `needsSandbox` set, so the sandbox opens when only a custom gate needs one. No `{files}` substitution.
- A selected gate with no `command` fails the attempt with one red gate result: `gate buf has no command in project server`.
- They are ordinary unit gates: a failing one returns the unit to its worker with the usual Return, `gate.result` events carry the gate's name, and escalation and stall logic are untouched.
- Not in the join re-gate or the landing re-gate (they run only `tests`, `typecheck` and `lint`).
- The gate specs live in `EngineConfig`, which `configHash` covers, so a changed command changes the hash.
- `heph run --dry-run`: the per-unit `gates` list becomes the gates that unit would run (built-ins plus the `customGatesFor` result) instead of every project gate name.

## 3. Docs and rollout

- SPEC §11 and §5 as-built paragraphs (command gates, why not TS files); NOTES "Custom command gates (2026-11-07)"; the "Not built" gate lists in NOTES corrected; ROADMAP's B line updated; one line in the chat-host skill and its Codex copy (kept identical by the existing test) on writing a gate-checked criterion and defining the gate in the repo's `config.yaml`.
- Compatibility: configs that list gate names keep loading; the only behavior change is that a unit which needs a gate with no command now fails its attempt loudly instead of passing without the gate. No ledger event, schema or projection changes.

## Testing

- Config: the string form, the object form and the list form parse; rejects for a reserved name, `always` without a command and an unknown key; a list-form layer normalizes; a later layer's entry replaces an earlier one whole; `config explain` lines; the repo JSON Schema accepts both forms.
- `customGatesFor`: a covering unit, a non-covering unit, an `always` gate, a test unit, a gate defined in another project.
- `namedCommandGate` with a scripted sandbox: pass, fail with evidence, timeout, no command.
- Engine: a gate-checked criterion's unit goes red on the gate and green after the fix; the sandbox opens when only a custom gate needs it; the join re-gate does not run custom gates.
- Dry run: the per-unit `gates` list.

## Not changed

Ledger events and projections, the plan and brief gates, the router and ladder, the join and landing re-gates, and the built-in gates.
