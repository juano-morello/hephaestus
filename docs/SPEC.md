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
- **Fan-out as built.** With `limits.parallel` above 1 (default 3, decided 2026-11-05 by the owner and to be tuned later; `1` restores the sequential order exactly) the engine runs independent units at the same time from a ready set: a unit is ready when its derived-edge predecessors are accepted, the plan gate's `tests_passable` rule holds over what is actually accepted, its scope (plus `hint --scope` additions) overlaps no in-flight unit's scope in the same repo, a test unit keeps its place in its project's canonical order (it starts only when every unit of the project ordered before it is accepted and nothing else of the project is in flight, and no unit of the project ordered after it starts until it is accepted; non-test units between two tests run together, other projects are unaffected), and a slot is free. The first escalation, stall, `blocked` or rate limit *drains* the pool (no new starts; in-flight units finish and are accepted if green) and then one `run.paused` is written (reason precedence: handoff, user, rate limit). Accepted attempts join the run branch under a per-repo lock: a fast-forward when the tip is where the attempt started, otherwise a cherry-pick replay onto the new tip and a re-gate of tests, typecheck and lint on the combined tree (a `join` gate records a replay conflict). OMP session creation is serialized process-wide. With `parallel` 1 the order and events are the sequential loop's (the topological, plan-order-on-ties order the plan gate's `tests_passable` simulates).
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
  - **Plan gates:** a failed plan goes back to the planner once, with its own output and the gate evidence. Two invalid answers fail the run. Measured as first-try vs second-try validity (`plan.answer`, `plan-proto --correct`).
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
- **Stacked changesets.** A run can be built on another run's unmerged branch (`heph new --stack-on <run>`; the parent must be `built` or `staged`). In each repo the child's base is the nearest ancestor in the `stack_on` chain that is built or staged, has `heph/<id>` in that repo and whose latest plan touches that repo (finished ancestors and leftover branches from an earlier plan are skipped, the target is the fallback); any other ancestor status makes the stack unresolvable. The child's fork point is derived from `Heph-Run` trailers, not stored. It lands with `git rebase --onto <onto> <fork point>`, opens its PR with the parent's branch as base while the parent is unmerged, and cannot merge until the parent is finished; when the parent finishes through `heph approve merge <parent>` or `heph merge status <parent>` (there is no poller; a parent merged on GitHub directly stays `staged` until `merge status` runs), its staged children are restacked onto the target and their PR base is retargeted. Whether a child needs a restack is read from the ledger, not its PR's base (GitHub retargets a PR by itself when it deletes a merged branch): the parent landed after the child's latest `merge.staged`, in a repo with a pull request an ancestor unmerged at that staging touched. `mergeChangeset` refuses such a child and `heph approve merge <child>` restacks it instead (`restacked`); a PR whose base is not the target is refused as well, as an additional guard. `approve merge` never merges a head staged after its own approval. A stacked PR merged by hand into the parent's branch (or before the parent landed) is recorded half-landed by `heph merge status`, never finished. See `docs/superpowers/specs/2026-11-05-stacking-fanout-design.md`.

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
run.created            (owner_node, stack_on?: the run this one is stacked on)
run.plan_ready
plan.answer            (attempt, outcome: valid | invalid | escalated, failures; one per planner answer)
run.plan_escalated     (reasons; the run waits for a revised Brief)
run.paused             (reason: rate_limit | handoff | user; retry_after?)
run.resumed            (reason: rate_limit | handoff | user | crash)
run.handed_off         (to)
run.adopted            (forced, old owner unreachable)
run.finished / run.failed
node.started / node.finished
unit.attempt.started / unit.attempt.finished
    (role, tier, model, effort, provider, usage, duration, outcome)
unit.attempt.interrupted   (reason: rate_limit | crash | handoff | user)
gate.result            (gate, verdict, reason, evidence)
unit.returned          (Return payload)
unit.accepted / unit.escalated / unit.needs_input
unit.stalled           (signature, attempts, failing; two red attempts in a row failed the same way)
merge.staged / merge.committed / merge.aborted
human.input            (hints, plan edits, budget overrides, approvals of a plan or a merge)
context.pack_built     (size, truncated items, expansions)
effect.intended        (effect, key, target, before?, after?; see section 13)
effect.done            (effect, key, state: applied | confirmed | abandoned, sha?, url?)
```

### Projections

`runs` (with `stack_on`), `units`, `attempts`, `gate_stats`, `usage`. Rebuildable anytime from events; the projection version bumps when a column is added (4 with `stack_on`), so older ledgers rebuild. A strict event schema means an older node rejects a `run.created` carrying `stack_on` on sync (mixed-version nodes are not supported for stacked runs). CLI status, dashboard and widgets read projections only.

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
  devserver: { ssh: devserver, labels: [linux, unattended], preferred: true }
  mbp:       { ssh: mbp.local, labels: [macos, godot-editor, fast] }
```

- **Sync is event union.** Nodes exchange events and blobs (`heph sync` + background sync when peers see each other). ULIDs + append-only + single owner means no conflicts. Each node keeps a sync cursor per peer.
- Any node can display any synced run; remote-owned runs are marked possibly stale. Only the owner advances a run.
- **Git is the code transport.** Unit branches push to the shared remote when reachable; offline they stay local and push on reconnect. Merge runs on the owner. Unreachable remote at merge time: run waits at `merge.staged`.
- Transport between nodes over the LAN or Tailscale.
- v0 ships coordinator and runner as separate modules talking over an internal API, even when in one process.

### v0 as built

- **Transport is SSH.** A node reaches another with `ssh <nodes.<id>.ssh> <heph> peer`: one JSON request and one JSON response per line over stdio (protocol 1). Nothing listens on the network; SSH keys are the auth, over the LAN or Tailscale.
- **Sync** pulls the peer's events after this node's cursor for it, then pushes this node's events after the peer's cursor for it; blobs travel with their events. Cursors are the peer's local arrival order (`seq`), not ULIDs, so events relayed through a third node are not missed. Each node keeps one cursor per peer, outside the event log.
- **Single writer is enforced by the ledger:** appending an event for a run another node owns is refused, except `run.created` and `run.adopted`. `run.handed_off` moves ownership.
- **Placement:** `heph new --on <node|local>`; by default the `preferred` node if it answers, else local. A remote owner plans and builds in its own checkout.
- **Workspaces are named** (`name:` in `workspace.yaml`). A node finds its checkout as `workspaces.<name>` in its home config, else `$HEPH_HOME/workspaces/<name>`, and clones it from the repos' `origin` remotes when missing. The heph files that aren't committed (`.heph/workspace.yaml`, each repo's `.heph/config.yaml`) come from the node that sends the work: a checkout heph made under `$HEPH_HOME/workspaces` takes them on every `heph new --on`, handoff, and command forwarded from a checkout of that workspace, so the owner runs with the sender's current config; a checkout configured under `workspaces.<name>` is yours and gets them only where it has none. A run on another node needs every repo to have an `origin`. Before a node takes a run (`heph new --on`, handoff), it makes its checkout and checks that a run there could land: each `origin` takes a push (a dry run, which asks for credentials), and the pull request client can open pull requests (with `gh`: logged in, with write access). It refuses with one line per problem, before anything is created or stopped. A fresh build starts from `origin/<target>` when the repo has that remote.
- **Commands for a run go to its owner:** a command that changes a run is carried out on the owner (`rpc` over the peer protocol), then this node syncs. Reading commands sync first and say "possibly stale" when the owner can't be reached.
- **Coordinator and runner:** the engine's coordinator decides and writes every event; a `Runner` executes one attempt. Only the in-process runner exists; leases and heartbeats come with cross-node runners (build order step 3).

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
- every task passes its project's tests, so in execution order (topological, plan order on ties) every criterion a test task checks is covered by the first non-test task in that project after it, or earlier. A criterion tested early but done by a later task (a docs entry, say) fails every task in between (decided 2026-11-04, after a LegendsAO run dead-ended on it)
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

As built, the defaults name exact model ids (`claude/claude-opus-5-5`, `claude/claude-sonnet-5-5`, `claude/claude-haiku-5-5`): OMP matches a bare `opus` or `sonnet` to an older model in its catalog. `heph doctor` shows what each routed model resolves to.

### Complexity

- Planner assigns `complexity` with a reason.
- Code sanity-checks against scope size, file count, lane and cross-repo contracts. Mismatch bumps up, never down.
- User can override per task in plan review.

### Escalation

- Attempt 1 at assigned tier.
- Red with substantive failures: next attempt one tier up (haiku -> sonnet -> sonnet high -> opus).
- `blocked: spec unclear`: no model bump, goes to replan.
- Stall: when a unit's last two red attempts have the same failure signature (its failing gates, reasons and evidence, as a hash), the engine writes `unit.stalled` and pauses the run for the user at once, without spending the remaining attempts or bumping the tier. The check spans escalations and restarts after a `human.input` for the unit or the run, so a hint buys fresh comparison. More attempts cannot fix a structural failure (a criterion outside the unit's scope, a wrong decision in the Brief); the user can.
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

- Target design; not the default yet (decided 2026-11-04, see Mac below: `native` on every node for now).
- One container per unit (Docker or rootless Podman) from per-project images (`heph/go-server`, `heph/godot-headless`, `heph/web`).
- Worktree bind-mounted read-write; everything else read-only or absent.
- Network off by default; per-project allowlist (module proxy, package registry).
- OMP runs outside the container with the container as its execution shell, keeping subscription credentials out of the sandbox.
- CPU, memory and time limits per unit.

### Mac

- ~~`container` mode by default (OrbStack or Colima).~~ **Decided 2026-11-04: `native` is the default on every node** until container mode has per-project images, a network allowlist and dependency caches (below). `container` stays available per node or workspace.
- `native` mode for label-locked tasks (Godot editor, Metal) with a restricted profile (`sandbox-exec` or dedicated user) and diff-scope as backstop. Native tasks may be restricted to lane `contained`.

As built in v0, native mode: commands see only `PATH`, `LANG` and a scratch `HOME` (never the project, so tool caches stay out of the diff); writes only in the project and temp; no network except loopback (bwrap gives a private loopback; macOS allows the host's); credential paths unreadable. Go reads the host's module cache with the proxy off and builds in a shared temp cache. Native is the default (decided 2026-11-04) because container mode can't build a real project yet: no per-project images, no network allowlist, no dependency caches. Those come before containers become the default again.

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

The intent is `effect.intended` and the confirmation `effect.done`, matched by a deterministic `key` (e.g. `run_branch_advance:<repo>:<unit>:a<n>`). Effects: `run_branch_reset`, `run_branch_advance`, `rebase`, `push`, `staging_ref`, `pr_open`, `pr_edit`, `pr_retarget`, `pr_merge`, `target_advance`. A stacked run's `rebase` keys carry the onto sha (`rebase:<repo>:<onto7>`) because it can rebase twice (onto the parent's branch, then the target); unstacked runs keep `rebase:<repo>`. `pr_retarget` (`PullRequests.setBase`; its `after` is a branch name, the only effect where it is not a sha) moves a restacked child's PR base to the target: `confirmed` when the base already is the target, else redone. The events that justify an effect are written with its intent, and those that follow from it with its confirmation, in one transaction each (a green attempt's verdict with the advance intent, `unit.accepted` with the advance's done), so a crash can't split them. Reconciling a pending intent writes its `effect.done`:

- `confirmed`: reality already matches (the ref is at `after`, the PR exists or is merged).
- `applied`: it can be finished from the intent alone (a run-branch advance whose branch is still at `before`).
- `abandoned`: it did not happen; the step that wanted it runs again.

A run branch at neither `before` nor `after` stops the resume: something else moved it. An effect that fails rather than stops is also closed as `abandoned`. Attempt-local work (the worktree, the attempt commit) is not an effect: an interrupted attempt is redone.

### Idempotent effects

- Branches/worktrees: deterministic names (`heph-attempt/<run>/<unit>/a<attempt>`), reused or reset to recorded base. Attempt branches live outside `heph/`: git cannot hold the changeset branch `heph/<run>` and branches under `heph/<run>/` at the same time.
- Pushes: compare remote ref to expected SHA before pushing.
- Pull requests: one already open for the head is reused; one already merged counts as merged and is not merged again.
- Merges: staging ref, then fast-forward; target already at expected SHA means done.
- Codegen and gates: pure, re-run.

### Resume behavior

A build is fresh when there is no `node.started` (build) since the latest `run.plan_ready`: each run branch is reset to its target. Otherwise it resumes: leftover worktrees are removed, pending effects reconciled, and `run.resumed` records why (`crash` when the run was still running).

- Worker interrupted: attempt marked `interrupted` (does not count against the 3), worktree reset, restart with a fresh pack. Attempt numbers continue across the run; they are never reused.
- Gate interrupted: re-run.
- Lost pause: a crash can leave a run `running` after a unit escalated or stalled and the drain finished but before `run.paused`. Resume detects it (an open `unit.escalated` or `unit.stalled`, or an interrupted attempt with reason `rate_limit`, `handoff` or `user`, with no later `run.paused`) and writes the pause instead of granting fresh attempts, in the same transaction as `run.resumed` (a crash between two writes would hide it from the next resume).
- Parallel join: the replay of an attempt onto a moved run-branch tip is attempt-local work (not an effect), redone on resume; `run_branch_advance` reconciles as before. Every open attempt of a parallel build is interrupted on resume.
- Accepted units are never redone. Their files still lock later units (from the recorded run-branch advance).
- Escalated unit: resuming the run gives it a fresh set of attempts, with its last Return and any new hints.
- Planner interrupted: replan from the brief (`heph plan revise <run>`); the plan exists only at `run.plan_ready`.
- Human checkpoint: run waits.
- Rate limit: `run.paused` with `retry_after`; scheduler resumes automatically or reroutes if the role allows. In v0 the scheduler is `heph run`, which waits in the foreground until `retry_after` (`--now` skips the wait).
- One process drives a run at a time (a pid lock under `$HEPH_HOME/locks`); a lock whose process is dead is taken over.

### Handoff

`heph handoff <run> <node>`:

1. Owner stops leasing, waits for or interrupts in-flight units (configurable)
2. Pushes all unit branches
3. Emits `run.handed_off`, syncs events and blobs
4. New owner reconciles and resumes

As built in v0: the owner interrupts the attempt in flight (it is marked interrupted with reason `handoff` and does not count; waiting is not built yet), pushes the run branches (`push` effects), writes `run.handed_off`, syncs, and asks the new owner to take the run. The new owner makes or finds its checkout, fetches the run branches, and resumes without redoing accepted units (`run.resumed`, reason `handoff`). Handoff is unchanged by fan-out: it interrupts every in-flight attempt (reason `handoff`). A handoff stopped at any step is finished by running it again on the old owner. A handoff is refused when a touched repo has no remote, and when the new owner's check of its checkout fails (section 7); either way the build goes on where it is. A `heph run` following the build keeps following it at the new owner until it ends there.

`heph adopt <run>`: forced takeover when the old owner is unreachable. Recorded loudly; the only path that could produce two writers. In v0 it is refused while the owner answers `hello`, unless `--force`.

### Testing

Chaos runs in the eval suite: kill the daemon at random points during golden tasks and assert identical outcomes.

v0 (before the daemon): a deterministic chaos test kills a run at every ledger write and around every effect, resumes it from the reopened ledger, and requires the same trees, commit counts, accepted units (one green attempt each), no pending effects and no leftover worktrees as a run never killed; `packages/engine/scripts/chaos-smoke.ts` does the same with real SIGKILLs of a child process.

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

As built in v0: `heph daemon` runs in the foreground (under systemd or launchd if you want it unattended). It serves HTTP on a Unix socket, `$HEPH_HOME/daemon.sock`, runs builds as jobs, and resumes at start the runs it owns that a killed process left running. It reschedules rate-limited builds after `retry_after`, and syncs with the configured nodes every `sync.interval_s` (default 30). The CLI is its client when it answers, and opens the node in-process otherwise. A build started from another node goes to the owner's daemon so it outlives the SSH session.

### CLI (primary)

```sh
heph new feature --brief brief.yaml [--on local|devserver] [--stack-on <run>] [--json]
heph plan show <run>
heph plan revise <run> "<instructions>"
heph run <run>
heph status [<run>]
heph explain <run> [<unit>]
heph hint <run> <unit> ["<text>"] [--scope <path>]... [--budget N]
heph approve plan|merge <run>
heph cancel <run>
heph handoff <run> <node>
heph adopt <run> [--force]
heph sync
heph daemon
heph peer                  (the far side of node-to-node traffic; run through ssh)
heph eval ...
heph retro
heph config explain
heph init
heph doctor [--tests]
heph help | --help
heph version | --version
heph ui
```

Every command supports `--json` with stable, versioned output schemas: `{ schema: 1, command, ok, data }` or `{ schema: 1, command, ok: false, error: { message } }` with a non-zero exit.

`heph new --stack-on <run>` builds the run on another run's branch (section 4). `heph status <run>` prints `stacked on <parent> (<parent's status>)` for a stacked run and, when more than one attempt runs, `in flight: T1/a1, T2/a1`; `heph explain` shows it on the `run created` line. `heph watch <run>` ends a staged child of an unmerged parent with `waiting for <parent>`. `heph approve merge <child>` before its parent is merged says `waiting for <parent>`; a restack that conflicts or fails its re-gate pauses the child: after the cause is fixed the user runs `heph run <child>`, then `heph approve merge <child>` (restacks and retargets, returns `restacked`, does not merge), then `heph approve merge <child>` again to merge. A staged child of a failed or cancelled parent ends `heph watch` with `stacked on <parent> (<status>): rebuild <child>`. `limits.parallel` (default 3) is shown by `heph config explain`.

`heph run` on a run whose latest plan isn't approved yet waits for the approval, then builds; it prints the build's events from when it starts.

`heph watch <run>` prints one line per milestone of a run (attempts, units accepted or returned, escalations, stalls, pauses, staging, the pull request) on stdout, and ends when the run is staged, finished, failed, escalated by the planner, or paused waiting for the user; a rate-limit pause is waited out. It works on any run on any node by polling status and events, so it needs no daemon (decided 2026-11-04, after the LegendsAO runs showed an agent in Claude Code seeing nothing of a background build). The skill starts it next to `heph run` through the host's background-command stream (Claude Code's Monitor).

`heph hint --scope` widens one unit's scope by the paths or globs given, relative to its project (decided 2026-11-04): the owner's direction can need a file the plan gave another task, and replanning for one file throws away accepted work. It is recorded as a `human.input` of kind `scope` and holds for that unit's later attempts; locked paths stay locked.

`heph doctor` checks what this node needs to plan, build and land, one line per check with the command that fixes a problem: the node's config, the workspace and its test commands, every routed model (one tiny call each), the sandbox, gh where repos land as pull requests, the daemon, and every configured node (reachable, same version). `--tests` runs each project's test command in the sandbox on a clean checkout of its target branch. It exits 1 when a check fails.

Installing (as built): `bun run install:heph` in a checkout of this repo builds the binary (stamped with its commit), installs it in `~/.local/share/heph` with a `~/.local/bin/heph` link, writes `~/.heph/config.yaml` if there is none (native sandbox; `--peer`/`--preferred` add nodes), runs the daemon under launchd (macOS) or systemd `--user` (Linux) with the installing shell's PATH, installs the Claude Code skill and its deny rule, and ends with `heph doctor`. `--remote <ssh host>` installs on another machine. Rerunning it upgrades in place; the daemon restarts and running builds resume.

The CLI works on the node's ledger (`$HEPH_HOME`, default `~/.heph`): through the daemon when one answers, else in-process. `heph run` builds and then stages the changeset (pull requests where repos have a remote, staging refs otherwise). In-process it builds in the foreground; through a daemon, or on another node, it follows the job's events until it is done. `heph approve merge` merges it. `heph merge status` follows pull requests merged on GitHub directly.

### Chat hosts (Claude Code, Codex)

- v0: CLI-first. A skill (Claude Code) and the same content in AGENTS.md (Codex) teach the agent to distill the conversation into a Brief, submit with `heph new --brief`, report plans and status, and never run `approve`.
- "With everything we've discussed, let's tackle this" maps to: agent writes `brief.yaml`, runs `heph new`, shows the plan, iterates via `heph plan revise`.
- `heph approve` added to host permission deny lists.
- As built: the skill is `integrations/claude/skills/heph/SKILL.md`, the Codex copy `integrations/codex/AGENTS.md` (a test keeps them identical). The installer puts the skill in `~/.claude/skills/heph/` and adds `Bash(heph approve:*)` to `permissions.deny` in `~/.claude/settings.json`.

### MCP server

As built (2026-11-05): `heph mcp` serves MCP over stdio, a thin adapter over the daemon API. It lives in `packages/cli/src/mcp/`, not a new package, because it needs the CLI's daemon client and a separate package would make a dependency cycle. SDK: `@modelcontextprotocol/sdk`, pinned 1.32.1.

Tools: `heph_new`, `heph_plan_show`, `heph_plan_revise`, `heph_run`, `heph_watch`, `heph_status`, `heph_explain`, `heph_hint`, `heph_cancel`, and `heph_approve` (v1.5, not built). Names use underscores because Claude's API restricts tool names to `[a-zA-Z0-9_-]`, so dotted names would not load. Every tool returns useful text first.

- `heph_new` embeds the Brief JSON Schema in its description, so the host agent can write a valid Brief without reading the spec.
- `heph_run` never waits for approval or for the build. It returns `awaiting_plan_approval` and starts nothing if the latest plan of a `planned`, `paused` or `built` run is not approved (the user approves it themselves). It returns `not_runnable` and starts nothing for failed, finished, staged or escalated runs, and for any other run without an approved plan that is not `running` (a `created` run has no plan yet). A `running` run resumes through `run` whatever its approval flag says. Otherwise it returns `started` or `already_running`. It can still take a couple of seconds when the daemon is unreachable during its first progress read (see retries below).
- `heph_watch` is a cursor long-poll (`wait_s` default 20, max 25), the pull-side twin of `heph watch`. Outcomes: `running`, `awaiting_plan_approval`, `waiting_for_you` (a pause for the user, a stalled unit included), `planner_escalated`, `waiting_for_parent` (a stacked run staged behind a parent that has not merged; `waiting_for` names it), `blocked_by_parent` (a stacked run whose parent failed, was cancelled or otherwise cannot land; it needs a rebuild, `blocked` says why), `staged`, `finished`, `failed`. Every outcome but `running` is a stop. The outcome comes from the same classification step as `heph watch` (`classifyRun` in `packages/cli/src/watch.ts`), so the two never disagree. A quiet poll on a `running` run ends with a heartbeat line. Quiet polls in other statuses return no lines. MCP progress notifications are sent best-effort; the tool result is the contract. A cancelled request (the host's `notifications/cancelled`) stops the poll at its next wait; a daemon call already in flight finishes first (at most its 20 s timeout).
- Daemon calls are bounded: `status`, `explain`, `planShow`, `hint`, `cancel` and `run` give up after 20 s with a timeout error; `newRun` and `revise` have no timeout, because they run the planner for minutes.
- Retries happen only inside `heph_watch` and `heph_run`'s progress step. The other tools and `heph_run`'s first status read do not retry. Only transient errors are retried: no daemon, a timed-out call, a dropped or refused socket. They are retried up to 8 times, 2 s apart (about 16 s), and never more than one interval past the poll's wait; `heph_run`'s progress step waits 0 s, so it gives up after one retry (about 2 s). An error the daemon answers (an unknown run id, a refusal) and a malformed answer come back at once.
- The daemon is required. When it is down the tool returns a clear error, re-checked on every call.
- Every string input is non-empty: `""` for a run id, unit, cursor, instructions or hint text is a validation error, not "omitted" (`heph_status` with `run` omitted lists every run; `run: ""` is an error).

Approval guarantee: the server never approves. Its method allowlist (`newRun`, `planShow`, `revise`, `run`, `status`, `explain`, `hint`, `cancel`) has no approve method, so a model calling the tools cannot approve a plan or a merge. The limit: any process of the same user can still call the daemon socket directly. Closing that is the v1.5 out-of-band approval work below. `heph_approve` stays a v1.5 item.

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
3. **Then:** cross-node runners, routing tiers with escalation, MCP server, dashboard, MCP Apps widgets.
   Built (2026-11-05): parallel fan-out (`limits.parallel`, drain, join) and stacking (`--stack-on`, restack, `pr_retarget`). Not built: multiple parents, optimistic joins, rate-limit throttling, cross-node runners.
4. **v1.5:** approvals.
5. **Later:** retro and constraint store, learned routing, additional worker backends.

### Kill criteria (4 weeks after v0 runs)

If fewer than half of runs reach merge without manual rewriting, or work keeps bypassing the harness for direct sessions, stop and keep the discipline as skills.

---

## 20. Open items

- OMP SDK/RPC surface stability across versions
- npm scope: `@hephaestus` is taken; choose a publishable scope before publishing. GitHub: `juano-morello/hephaestus`
- Exact MCP Apps rendering support in Claude Code and the Codex app
