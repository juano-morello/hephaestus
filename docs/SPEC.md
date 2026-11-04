# Hephaestus: Specification v0

Status: design locked, pre-implementation
License: MIT, open source from the first commit
Package: `@hephaestus/*` | CLI binary: `heph` | Config dir: `.heph/`

---

## 1. What it is

Hephaestus is a code-controlled agent harness for software engineering. Code owns the control flow; LLM calls are functions with typed inputs and typed outputs that might be wrong, and every call is followed by a deterministic check.

```
Code -> LLMs -> Result
```

Core properties:

- **The engine owns the outer loop.** Retries, scope, merges, gates and checkpoints are decided by code. Agents return data; they never decide what runs next.
- **Deterministic control flow.** Outputs are nondeterministic; what runs next given the same gate results is not.
- **Vendor neutral.** Workers are pluggable backends. OMP (oh-my-pi) is backend #1.
- **Any machine is a full node.** The local machine is always a valid fallback for the devserver.
- **Single-repo, multi-repo and monorepo** supported from day one.

### Non-goals for v0

- Approvals enforcement (deferred to v1.5)
- Learned model routing (v2)
- Multi-user / hosted coordinator
- Cost in currency (tokens tracked, cost computed later)

---

## 2. Core concepts

### Loop vs graph

- A **loop** lives inside a node: produce, check, correct, repeat until green. Max 3 attempts per unit.
- A **graph** lives between nodes: split, fan out, merge, gate, send back.
- A check is something a program can evaluate. "Looks good", "model is confident" and "no errors raised" are not checks.

### Node kinds

| Kind | What it is |
|---|---|
| splitter | Cuts work into units (the planner) |
| worker | One bounded unit, one lens, own context |
| code | Merge, rank, dedupe, compare. Pure code, never a model |
| gate | Deterministic checks deciding accept / return / escalate |
| human | Blocking checkpoint (plan, merge) |

Rule: if a transformation can be described without "judge, decide, assess, summarize", it is a code node.

### Return paths

- **Correction edge (short):** a gate returns one unit to its producer with reason, evidence and scope. Never the batch.
- **Learning edge (long):** accepted results produce constraints that land in the splitter's brief for future runs. Gated by eval and human review.

### Lanes (blast radius)

| Lane | Examples | Policy |
|---|---|---|
| contained | isolated function, test, copy | may auto-merge |
| wide | shared utility, schema addition, protocol | deterministic gates + clean trajectory |
| irreversible | migrations, deletions, prod data, deploys | never auto-opens |

Gate evidence order: deterministic results, run trajectory, historical rollback rate of the node, model self-assessment last.

---

## 3. Architecture

```
hephaestus
├── engine      graph runner, lanes, retries, scope enforcement
├── gates       tests, diff-scope, lint, typecheck, req->check mapping, plan gates
├── ledger      append-only events, projections, blob store
├── context     context pack builder + per-stack adapters
├── learning    retro, constraint store, proposal queue
├── roles       role specs, tiers, prompts
├── workers     omp | claude-cli | codex-cli (pluggable)
├── sandbox     container | native-restricted
├── node        coordinator + runner, sync, handoff
└── surfaces    CLI, daemon API, MCP server, dashboard, MCP Apps widgets
```

### Runtime and language

- **TypeScript on Bun.** OMP is a single Bun process with TS/Rust internals, so the core imports it in-process (SDK/RPC) instead of parsing CLI output.
- **zod** for every schema: LLM structured output and config, with JSON Schema generated for editor autocomplete.
- Runtime-specific code isolated behind two modules (`db`, `proc`). CI runs on Bun; Node compatibility kept where cheap.
- Distribution: `bun build --compile` single binary for the devserver; npm package for dev.
- **Pin the exact OMP version.** Upgrade only after the eval suite passes on the new version.

### Worker interface

```ts
spawn(role, brief, workdir, tools, model, effort) -> {
  output, diff, transcript, usage, exit
}
```

OMP is the only backend in v0. The interface stays so `claude -p` and `codex exec` can be added as ~50-line adapters (auth breakage fallback, provider benchmarking).

OMP's own subagents are not used for orchestration. OMP is the single-unit worker; fan-out, gating and retries stay in the engine.

---

## 4. Workspace model

Two concepts, never conflated:

- **Repo:** a VCS unit. Owns branches, worktrees, merges.
- **Project:** a gate unit. Owns stack, commands, lanes, acceptance tests, conventions.

| Layout | Repos | Projects |
|---|---|---|
| Single repo | 1 | 1 |
| Monorepo | 1 | N (paths inside it) |
| Multi-repo | N | N |

```yaml
# .heph/workspace.yaml (omit for single repo; implied)
repos:
  server: ./server
  client: ./client
  web:    ./web
  proto:  ./proto
projects:
  proto:  { repo: proto,  path: ., stack: schema }
  server: { repo: server, path: ., stack: go,    depends_on: [proto] }
  client: { repo: client, path: ., stack: godot, depends_on: [proto] }
  web:    { repo: web,    path: ., stack: ts }
integration:
  gate: ./scripts/integration.sh
```

Rules:

- A task targets exactly one project. A unit never spans two.
- A run is a **changeset**: one branch name across every repo it touches (`heph/<run>`).
- Diff-scope gates are path-based on project roots (monorepo safety).
- Merge is always a set, ordered by `depends_on`, via staging refs, then fast-forward all at once. A changeset never half-lands.
- Worktrees are per unit per repo.

---

## 5. Configuration

Principle: **configure the what, code the how.** Workflows, roles, gates, lanes and models are config. Loop semantics are built-in node types. Custom pieces are TS files. Config never grows conditionals or loops.

### Layers (later wins)

```
built-in defaults
-> ~/.heph/config.yaml          (providers, budgets, nodes, defaults)
-> <workspace>/.heph/workspace.yaml
-> <repo>/.heph/config.yaml     (project gates, commands, lanes)
-> <repo>/.heph/workflows/*.yaml
-> CLI flags / env
```

### Example

```yaml
# .heph/config.yaml
project:
  test: go test -race ./...
  typecheck: go vet ./...
  lint: staticcheck ./...

providers:
  claude: { backend: omp, auth: subscription }
  openai: { backend: omp, auth: subscription }

lanes:
  contained:    { auto_merge: true }
  wide:         { gates: [tests, typecheck, scope, coverage] }
  irreversible: { human: required }

limits:
  parallel: 4
  attempts_per_unit: 3
```

```yaml
# .heph/workflows/feature.yaml
name: feature
nodes:
  - { id: gather,  type: context }
  - { id: plan,    type: splitter, role: planner, gate: plan_schema }
  - { id: build,   type: fanout,   over: plan.tasks }
  - { id: merge,   type: merge }
  - { id: review,  type: panel,    role: reviewer }
  - { id: approve, type: human,    when: "lane != contained" }
  - { id: docs,    type: worker,   role: documenter }
```

```ts
// .heph/gates/no-console.ts
export default defineGate("no_console", async ({ diff }) =>
  diff.added.some(l => l.includes("console.log"))
    ? fail("console.log added") : pass());
```

### Ergonomics

- Schema-validated config with editor autocomplete; errors point at the exact line.
- `heph init` detects stack and fills commands.
- Presets: `extends: hephaestus/presets/go-tdd`.
- Prompts as files: `.heph/roles/<role>.md`, overridable per project.
- `heph config explain` prints resolved config with the source of every value.
- `--dry-run` renders graph, briefs and resolved roles without spawning.
- Config hash recorded on every run and attempt.
- Learned constraints live in `.heph/constraints.yaml`, reviewed in git, never mixed into hand-written config.

---

## 6. Ledger

### Principles

- **Append-only events; state is derived.** Rows are never updated. Current state is a projection.
- **SQLite per node** (WAL mode). Each node has its own ledger and blob store.
- **Payloads by reference.** Transcripts, diffs and gate logs go to a content-addressed blob store (`.heph/blobs/<sha256>`); events point to them.
- **Full id chain on every event**, so any query is one filter.

### Envelope

```ts
Event = {
  id: ulid,                 // sortable, global ordering
  ts: string,
  type: string,             // "unit.attempt.finished"
  schema: 1,
  node_id: string,          // which node wrote it
  run_id, changeset_id,
  repo?, project?, graph_node?, unit_id?, attempt?,
  runner_id?,
  actor: "engine" | "worker" | "human" | "gate",
  config_hash, prompt_hash?,
  data: {...},              // small, typed per event type
  blobs?: { transcript?: sha, diff?: sha, log?: sha }
}
```

### Event types (v0)

```
run.created            (owner_node)
run.plan_ready
run.plan_escalated     (reasons; the run waits for a revised Brief)
run.paused / run.resumed   (reason: rate_limit | handoff | user)
run.handed_off         (to)
run.adopted            (forced, old owner unreachable)
run.finished / run.failed
node.started / node.finished
unit.attempt.started / unit.attempt.finished
    (role, tier, model, effort, provider, usage, duration, outcome)
unit.attempt.interrupted
gate.result            (gate, verdict, reason, evidence)
unit.returned          (Return payload)
unit.accepted / unit.escalated / unit.needs_input
merge.staged / merge.committed / merge.aborted
human.input            (hints, plan edits, budget overrides)
context.pack_built     (size, truncated items, expansions)
```

### Projections

`runs`, `units`, `attempts`, `gate_stats`, `usage`. Rebuildable anytime from events. CLI status, dashboard and widgets read projections only.

### Rules

- `config_hash` and `prompt_hash` on every attempt, so the retro can separate model drift from config changes.
- Gate events record **evidence** (failing test, file:line, expected vs got), not only pass/fail.
- Eval runs are flagged and excluded from real-run stats.

---

## 7. Multi-node: coordinators and runners

Constraint from day one: **every machine is a full node.** Devserver as coordinator is a preference, not the architecture.

- Same binary and daemon on every machine (devserver Ubuntu, MacBook).
- **Coordinator chosen at run creation:** preferred node if reachable, else local. Override: `--on local|devserver`.
- **A run is owned by exactly one coordinator for life.** Only the owner writes that run's events. No multi-writer.
- **Runners are borrowed across nodes when reachable.** Units are leased with heartbeats; an expired lease reschedules the unit.
- **Runner labels** drive placement:

```yaml
nodes:
  devserver: { labels: [linux, unattended], preferred: true }
  mbp:       { labels: [macos, godot-editor, fast] }
```

- **Sync is event union.** Nodes exchange events and blobs (`heph sync` + background sync when peers see each other). ULIDs + append-only + single owner means no conflicts. Each node keeps a sync cursor per peer.
- Any node can display any synced run; remote-owned runs are marked possibly stale. Only the owner advances a run.
- **Git is the code transport.** Unit branches push to the shared remote when reachable; offline they stay local and push on reconnect. Merge runs on the owner. Unreachable remote at merge time: run waits at `merge.staged`.
- Transport between nodes over the LAN or Tailscale.
- v0 ships coordinator and runner as separate modules talking over an internal API, even when in one process.

---

## 8. Core schemas

All versioned (`schema: 1`). Every schema has a validator that runs as a gate.

### Brief (chat agent or CLI -> harness)

```ts
Brief = {
  schema: 1,
  goal: string,                 // outcome, not method
  context: string,              // distilled discussion, reasons for decisions
  decisions: string[],          // settled; planner must not reopen
  constraints: string[],
  acceptance: Criterion[],      // >= 1
  out_of_scope: string[],
  known_paths?: { project: string, paths: string[] }[],
  open_questions: string[],     // must be empty to plan
  source: "claude-code" | "codex" | "cli" | "omp"
}
Criterion = {
  id: string,
  text: string,
  kind: "behavior" | "nonfunctional",
  check?: { gate: string }     // omitted: checked by a test task; set: checked by that gate
}
```

Brief gate: acceptance non-empty, no open questions, every project exists, every gate named by a `check` is configured in some project. Failures return to the submitting agent so it asks the user.

### Plan (planner -> engine)

```ts
// The planner returns exactly one of these.
PlannerOutput = Plan | Escalation
Plan = { schema: 1, brief_hash: string, tasks: Task[], risks: string[] }
// brief_hash is stamped by the engine after parsing; the planner never outputs it.
// Before parsing, the engine drops null-valued object fields at any depth, so null reads as
// absent; a null inside an array still fails the schema.
Escalation = { schema: 1, escalate: string[] }   // >= 1 concrete reason

Task = {
  id: string,
  title: string,
  kind: "test" | "implement" | "codegen" | "docs" | "migration",
  project: string,
  lane: "contained" | "wide" | "irreversible",
  complexity: "trivial" | "standard" | "complex",
  complexity_reason: string,
  scope: string[],              // path globs relative to project
  covers: string[],             // Criterion ids
  produces?: string[],          // "proto:LootMsg", "fn:StackItems", "test:StackCap"
  consumes?: string[],
  context_budget?: { tokens: number, reason: string },
  spec: string
}
```

**Edges are derived, not declared:** an edge exists only where a task consumes what another produces.

**Escalation is the planner's honest exit**, like `blocked` for workers. The planner returns an Escalation instead of a Plan when the Brief cannot be planned without reopening a decision, breaking a constraint, guessing what a criterion means, skipping a required approval, or adding work the Brief forbids or never names (a migration, a new persistence mechanism). One concrete reason per problem. Ordinary uncertainty (file names, helper shapes) goes in `risks`, not `escalate`. An Escalation is not a plan gate failure: no retry, no replan. Its reasons return to the submitting agent the same way as a brief gate failure, so it asks the user and submits a revised Brief.

Plan gates (pure code):

- task ids are unique (schema); every task's project exists in the workspace
- every Criterion covered: test-checked ones by at least one `test` task; gate-checked ones by a task in a project where that gate is configured, and never by a `test` task
- every `consumes` resolves to exactly one `produces` (an artifact produced twice is ambiguous and fails); graph is acyclic
- every test-checked criterion an `implement` task covers is covered by a `test` task in the same project that precedes it: the test task produces a `test:<Name>` artifact the implement task consumes (directly or through a chain). An implement task with empty `covers`, or covering only gate-checked criteria, fails
- parallel tasks (no path between them) in the same repo have non-overlapping scopes, compared repo-relative so projects with nested roots are covered; with the repo's file list, globs are compared on the files they match
- scopes point at directories that exist (needs the file list); new files in existing directories are listed for review
- `migration` forces lane `irreversible`
- complexity sanity, bumps up, never down: lane `wide` or `irreversible` is at least `standard`; consuming another project's artifact is at least `standard`; more than 5 scope globs is `complex`
- size limits (too big means replan), configurable under `limits`: at most 12 tasks, at most 8 scope globs per task, no empty scope, never `**` or `**/*` alone

Editing protocol definitions in a schema project is task kind `codegen` (test-before-implement does not apply to it). The brief gate also rejects duplicate criterion ids.

### UnitBrief (engine -> worker, built by code only)

```ts
UnitBrief = {
  schema: 1,
  task: Task,
  criteria: Criterion[],        // the Brief criteria this task covers, with their text
  decisions: string[],          // from the Brief; settled, the worker must not reopen them
  role: string,
  tier: "trivial" | "standard" | "complex",
  context: ContextPack,
  constraints: string[],        // brief + learned, for this node type
  locked_paths: string[],
  feedback?: Return,
  output_schema: string
}
```

### WorkerResult (worker -> engine)

```ts
WorkerResult = {
  schema: 1,
  summary: string,
  claims: string[],
  touched: string[],            // checked against the real diff
  notes_for_reviewer?: string,
  blocked?: { reason: string }  // honest exit: escalates to replan
}
```

The diff is the truth. `touched` mismatch with the diff is a gate failure.

### Return (gate failure -> next attempt)

```ts
Return = {
  schema: 1,
  unit_id, attempt,
  verdict: "red",
  reasons: { gate: string, reason: string, evidence: string[] }[],
  scope: string[],              // narrowed, usually the failing files
  instruction: "fix only the listed failures; do not modify locked paths"
}
```

### Test locking

`test` tasks run first. Their outputs become `locked_paths` for dependent `implement` tasks. The diff-scope gate fails any attempt that modifies them. If the implementer believes a test is wrong, the only path is `blocked`, which escalates to the user or a replan.

---

## 9. Context packs

Each worker gets what it needs, built deterministically. Workers may still explore with OMP tools, but the pack makes exploration the exception.

```ts
ContextPack = {
  schema: 1,
  budget_tokens: number,
  project: { name, stack, commands: { test, typecheck, lint } },
  conventions: string,          // .heph/conventions.md, hand-written, ~1k tokens cap
  repo_map: string,             // trimmed tree + exported symbols
  files: { path, content | outline, why }[],
  contracts: { name, content }[],
  locked: { path, content }[],
  constraints: string[],
  feedback?: Return
}
```

### Build order (all code, no LLM summarization)

1. Scope files in full
2. Neighbors (imports / importers) as outlines via language tooling
3. Contracts in full (everything the task consumes)
4. Locked tests in full
5. Repo map
6. Fill by priority: locked > contracts > scope > feedback > neighbors > map. Truncations recorded in the ledger.

### Per-stack adapters

`neighbors()`, `outline()`, `repo_map()` per stack: Go (gopls / go/packages), TS (tsserver), GDScript (gdtoolkit or regex outline in v0).

### Budgets are a target, not a wall

- Default per role in config.
- Planner may size it per task (`context_budget` with reason) under the project ceiling.
- Auto-grow: heavy exploration or `blocked: needs more context` grows the next pack (1.5x, then 2x) without counting as a failure.
- User override anytime: `--budget`, per project/role in config, or `heph hint <run> <unit> --budget`.
- Ceiling is a safety rail: hitting it emits `unit.needs_input` and pauses the unit, never fails it.
- Every expansion is logged for the retro.

### Cross-attempt rule

Attempts 2 and 3 get a freshly built pack plus the Return. Previous transcripts are never carried forward.

---

## 10. Roles and model routing

**Role x complexity tier -> model + effort.** Spend on thinking (planning, complex review), save on typing (implementation from a good plan).

```yaml
roles:
  planner:
    default:  { model: claude/opus,   effort: high }
  test_author:
    trivial:  { model: claude/haiku }
    standard: { model: claude/sonnet, effort: medium }
    complex:  { model: openai/gpt,    effort: high }
  implementer:
    trivial:  { model: claude/haiku }
    standard: { model: claude/sonnet, effort: medium }
    complex:  { model: claude/sonnet, effort: high }   # opus via escalation
  reviewer:
    standard: { model: claude/sonnet, effort: high }
    complex:  { model: claude/opus,   effort: high }
  documenter:
    default:  { model: claude/haiku }
diversify: false   # true: test_author and implementer on different providers
```

### Complexity

- Planner assigns `complexity` with a reason.
- Code sanity-checks against scope size, file count, lane and cross-repo contracts. Mismatch bumps up, never down.
- User can override per task in plan review.

### Escalation

- Attempt 1 at assigned tier.
- Red with substantive failures: next attempt one tier up (haiku -> sonnet -> sonnet high -> opus).
- `blocked: spec unclear`: no model bump, goes to replan.
- Interrupted or rate-limited attempts never escalate.
- Fallback providers used only on rate limit or provider failure, logged as such.

Learned routing from ledger and eval data is v2.

---

## 11. Gates

- Written as code, run in the same sandbox as the worker.
- Built-ins: tests, typecheck, lint, diff-scope (vs plan scope + locked paths), touched-vs-diff, coverage delta, requirement-to-check mapping, plan gates, brief gate, project-imports-headless (Godot).
- Integration gate per workspace, run at merge on the full changeset (e.g. headless Go server + scripted bot client).
- Custom gates as TS files in `.heph/gates/`.
- Flaky gates are worse than none: gate flakiness is tracked in `gate_stats` and surfaced.

---

## 12. Sandboxing

Principles:

- Workers get the worktree and nothing else.
- Gates run in the same sandbox as the worker.
- The engine holds privileges: git push, merge, network beyond allowlist, secrets.

### Devserver

- One container per unit (Docker or rootless Podman) from per-project images (`heph/go-server`, `heph/godot-headless`, `heph/web`).
- Worktree bind-mounted read-write; everything else read-only or absent.
- Network off by default; per-project allowlist (module proxy, package registry).
- OMP runs outside the container with the container as its execution shell, keeping subscription credentials out of the sandbox.
- CPU, memory and time limits per unit.

### Mac

- `container` mode by default (OrbStack or Colima).
- `native` mode for label-locked tasks (Godot editor, Metal) with a restricted profile (`sandbox-exec` or dedicated user) and diff-scope as backstop. Native tasks may be restricted to lane `contained`.

### Secrets

- Declared per project (`secrets: [TEST_DB_URL]`), resolved from local file or keychain.
- Injected only into gate runs that need them, never into worker sessions.
- Never production credentials. Integration uses throwaway local services per run.

### OMP integration

OMP has no pluggable execution backend, and its built-in file tools run in the host process with no path limits. So the worker disables every OMP built-in tool and gives the model its own tools (`read`, `write`, `edit`, `bash`, `submit_result`), which act inside the sandbox. OMP, the credentials and model calls stay on the host. Settings are isolated: no MCP, LSP, extensions, skills, rules, context files or model fallback.

---

## 13. Resume and idempotency

### Intent, effect, confirm

Every side effect writes an intent event, performs the effect, writes a confirmation. On resume, intents without confirmations are reconciled against reality.

### Idempotent effects

- Branches/worktrees: deterministic names (`heph-attempt/<run>/<unit>/a<attempt>`), reused or reset to recorded base. Attempt branches live outside `heph/`: git cannot hold the changeset branch `heph/<run>` and branches under `heph/<run>/` at the same time.
- Pushes: compare remote ref to expected SHA before pushing.
- Merges: staging ref, then fast-forward; target already at expected SHA means done.
- Codegen and gates: pure, re-run.

### Resume behavior

- Worker interrupted: attempt marked `interrupted` (does not count against the 3), worktree reset, restart with a fresh pack.
- Gate interrupted: re-run.
- Accepted units are never redone.
- Planner interrupted: replan from the brief; the plan exists only at `run.plan_ready`.
- Human checkpoint: run waits.
- Rate limit: `run.paused` with `retry_after`; scheduler resumes automatically or reroutes if the role allows.

### Handoff

`heph handoff <run> <node>`:

1. Owner stops leasing, waits for or interrupts in-flight units (configurable)
2. Pushes all unit branches
3. Emits `run.handed_off`, syncs events and blobs
4. New owner reconciles and resumes

`heph adopt <run>`: forced takeover when the old owner is unreachable. Recorded loudly; the only path that could produce two writers.

### Testing

Chaos runs in the eval suite: kill the daemon at random points during golden tasks and assert identical outcomes.

---

## 14. Evaluation

### Golden tasks

```yaml
# .heph/evals/stacking-cap.yaml
id: stacking-cap
workspace_ref: { server: a1b2c3d, proto: 9f8e7d6 }
brief: ./briefs/stacking-cap.yaml
oracle:                                         # paths in this file are relative to it
  hidden_tests:                                 # never shown to the harness
    - project: server
      from: ./oracle/stacking_cap_test.go
      to: inventory/stacking_cap_test.go        # relative to the project root
  must_pass:
    - { project: server, run: go test ./inventory/... }
  must_not_touch:
    - { project: server, paths: [persistence/**] }
tags: [server, contained, small]
```

Every oracle entry names its project, so one task can check several projects. Every repo a task touches is pinned in `workspace_ref`. A task is not runnable until its hidden tests exist.

- 5 to 10 to start: server-only, protocol + server, client logic, cross-repo, and at least one that should escalate.
- A should-escalate task sets `expect: escalate` instead of `oracle`. It is solved when the planner returns an Escalation, and missed when it returns a Plan, even one that passes every plan gate.
- Hidden oracle tests written by the user, applied after the run.
- Pinned commits for reproducibility.

### `heph eval`

```sh
heph eval --suite core --runs 3 --label planner-v4
heph eval compare planner-v3 planner-v4
```

Runs each task N times on throwaway worktrees, flagged as eval in the ledger.

### Metrics

Solved rate (oracle green), first-pass plan validity on plannable tasks, attempts per unit, escalation rate, scope violations caught, tokens and wall time per solved task, honest failure rate on should-escalate tasks (planner Escalation returned), false escalation rate on plannable tasks. Comparisons show run-to-run spread.

### Rules

- Any change to prompts, roles, routing or engine logic gets an eval run before becoming default.
- Retro-proposed constraints must not regress the suite.
- Every interesting real-run failure becomes a new golden task.
- Cost control: `--runs 1` for quick checks, full suite overnight on the devserver, tag subsets for iteration.

---

## 15. Learning (retro)

- Retro reads ledger data, not transcripts.
- Proposes **constraints**: versioned, scoped (workspace / project / stack / node type), with evidence runs.
- Constraints land in the splitter/planner brief, not in every worker prompt.
- Acceptance requires evidence threshold (N occurrences) plus user review and no eval regression.
- Constraints that stop firing expire.
- Lives in `.heph/constraints.yaml`, changed via reviewable diffs.
- Built last: needs real ledger volume to be more than noise.

---

## 16. Surfaces

### Daemon

Owns runs, ledger, worktrees, scheduling. Runs on every node. Everything else is a client.

### CLI (primary)

```sh
heph new feature --brief brief.yaml [--on local|devserver] [--json]
heph plan show <run>
heph plan revise <run> "<instructions>"
heph run <run>
heph status [<run>]
heph explain <run> [<unit>]
heph hint <run> <unit> "<text>" [--budget N]
heph approve plan|merge <run>
heph cancel <run>
heph handoff <run> <node>
heph adopt <run>
heph sync
heph eval ...
heph retro
heph config explain
heph init
heph ui
```

Every command supports `--json` with stable, versioned output schemas.

### Chat hosts (Claude Code, Codex)

- v0: CLI-first. A skill (Claude Code) and the same content in AGENTS.md (Codex) teach the agent to distill the conversation into a Brief, submit with `heph new --brief`, report plans and status, and never run `approve`.
- "With everything we've discussed, let's tackle this" maps to: agent writes `brief.yaml`, runs `heph new`, shows the plan, iterates via `heph plan revise`.
- `heph approve` added to host permission deny lists.

### MCP server

Thin adapter over the daemon API. Tools: `heph.new`, `heph.plan.show`, `heph.plan.revise`, `heph.run`, `heph.status`, `heph.explain`, `heph.hint`, `heph.cancel`, `heph.approve` (v1.5). Every tool returns useful structured text first.

### Dashboard and MCP Apps widgets

- One views bundle served by the daemon, powering both `heph ui` (local web dashboard) and MCP Apps widgets inline in supporting hosts.
- Hosts that don't render MCP Apps see the text result; the agent links to the dashboard.
- Widget actions call the daemon API, never the model.
- Widgets in order: run graph, plan review, gate results, changeset diff summary, ledger charts (attempts, escalations, tokens, provider usage vs limits), retro proposals.

### Approvals

Deferred to v1.5. Planned: out-of-band confirmation (TTY or one-time code via phone ping), MCP elicitation, approve buttons in widgets, irreversible lane approvals only via out-of-band path.

---

## 17. Subscriptions and rate limits

- Providers via OMP using Claude and ChatGPT subscriptions.
- Risk acknowledged: subscription access from third-party tools can break or be restricted; the worker interface and API-key fallback exist for this. Review provider terms periodically.
- Rate limits are a scheduling input: track remaining budget per provider, throttle parallelism, route low-stakes nodes to the less-loaded provider, pause cleanly instead of failing.

---

## 18. Dogfooding target

Small MMORPG across three projects: Go server, Godot client, web. Optional shared protocol repo/package.

### Gate strength

- **Go server (strongest):** `go build`, `go vet`, `staticcheck`, `go test -race`. Simulation logic is ideal for locked acceptance tests.
- **Web:** typecheck, lint, unit tests, Playwright.
- **Godot client:** gdUnit4 or GUT headless, gdtoolkit lint, headless import gate. Scenes, UI layout and feel go to a human lane.

### Protocol

- Single source of truth for messages with codegen for Go and the client. Generated files never hand-edited by agents.
- Protocol tasks are their own units, ordered before dependent server/client units.
- Integration gate at merge: headless server + scripted bot client.

### Lanes for the game

- contained: isolated server logic, client logic
- wide: protocol, shared data tables, persistence schema
- irreversible: migrations on live data, anything touching accounts

### First runs

1. Server-only feature with clear rules (item stacking, cooldowns)
2. Protocol + server feature with bot-client integration test
3. Full-stack feature including client logic

---

## 19. Build order

0. **Planner prototype (1 day):** planner prompt + Plan schema + plan gates as a script against 2 to 3 real server features. Targets: ~70% first-try plan validity on plannable Briefs; should-escalate Briefs return an Escalation and plannable ones do not. Riskiest assumption; goes first.
1. **Golden tasks (half a day):** first 5 with hidden oracle tests.
2. **v0:**
   1. Ledger + projections + blob store
   2. Engine with one sequential implement loop
   3. OMP worker in a sandbox
   4. Gates (tests, diff-scope, typecheck, locked paths, touched-vs-diff)
   5. Multi-repo changesets and set merge
   6. CLI with `--json`
   7. Resume and idempotency
   8. Node model: coordinator/runner split, local fallback, sync, handoff
3. **Then:** parallel fan-out, cross-node runners, routing tiers with escalation, MCP server, dashboard, MCP Apps widgets.
4. **v1.5:** approvals.
5. **Later:** retro and constraint store, learned routing, additional worker backends.

### Kill criteria (4 weeks after v0 runs)

If fewer than half of runs reach merge without manual rewriting, or work keeps bypassing the harness for direct sessions, stop and keep the discipline as skills.

---

## 20. Open items

- OMP SDK/RPC surface stability across versions
- npm scope: `@hephaestus` is taken; choose a publishable scope before publishing. GitHub: `juano-morello/hephaestus`
- Exact MCP Apps rendering support in Claude Code and the Codex app
