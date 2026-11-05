# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `heph mcp`: a stdio MCP server, inside the compiled `heph` binary, that lets chat hosts drive heph through nine typed tools and can never approve anything.

**Architecture:** A thin adapter in `packages/cli/src/mcp/` over the daemon's Unix-socket client (`daemonAt`), behind a hardcoded method allowlist. `heph_run` starts the job and returns; `heph_watch` is a cursor-based long-poll over `status` + `explain` using `isMilestone`/`watchLine` from `watch.ts`. No engine or daemon changes.

**Tech Stack:** Bun, TypeScript, zod 4.6.7 (repo-pinned), `@modelcontextprotocol/sdk` (exact pin chosen in Task 2), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-11-05-mcp-server-design.md`

## Global Constraints

- stdio transport only; nothing listens on a port. stdout is the protocol channel: all logging to stderr.
- Callable daemon methods are exactly: `newRun`, `planShow`, `revise`, `run`, `status`, `explain`, `hint`, `cancel`. No tool whose name contains `approve`.
- Tool names are underscore-style: `heph_new`, `heph_plan_show`, `heph_plan_revise`, `heph_run`, `heph_watch`, `heph_status`, `heph_explain`, `heph_hint`, `heph_cancel`.
- Results carry text first (short, with a `next:` line) plus `structuredContent` shaped like the equivalent CLI `OUTPUT` schema (`packages/cli/src/output.ts`). Failures are `isError` results carrying the daemon's message.
- Daemon down: every tool returns `isError` with "heph daemon is not running: start it with `heph daemon`, or rerun `bun run install:heph`"; the daemon is re-checked on every call.
- `heph_watch`: `wait_s` default 20, clamped to 0..25; outcomes are `running`, `awaiting_plan_approval`, `waiting_for_you`, `planner_escalated`, `staged`, `finished`, `failed`.
- Pin the SDK to an exact version at least two weeks old. Do not edit `packages/cli/src/watch.ts` (the stall-detection stream is changing it) or `packages/engine`/daemon behavior; `main.ts` gets only the `mcp` command.
- Repo rules: never add Co-Authored-By or any AI/Claude attribution to commits or PRs. Lint is `bun run lint` (biome), types `bun run typecheck`, tests `bun test`.

## Review Focus

1. `heph_new` with an invalid Brief, or a Brief passed as a string: clear message naming the problem, no daemon call. (Task 5)
2. Unknown run id or an id on another node: the daemon's message comes back as `isError`, not a crash. (Task 4)
3. Daemon restarts or drops mid long-poll: `heph_watch` retries about a minute like `watch.ts`, then returns `isError`; the server stays alive. (Task 3)
4. `heph_run` called twice, or on a plan not yet approved: second call is `already_running` not an error; unapproved starts nothing. (Task 6)
5. Anything written to stdout other than JSON-RPC corrupts the session: the integration test asserts every stdout line parses as JSON-RPC. (Task 7)

---

## File Structure

```
packages/cli/src/mcp/
  guard.ts    allowlist + per-call daemon resolution (McpClient, guardedClient, NoDaemonError)
  watch.ts    watchStep: one long-poll step of the milestone feed
  text.ts     short text renderers with `next:` lines
  tools.ts    registerTools(server, ctx): the nine tools
  server.ts   createMcpServer(ctx): McpServer + registerTools
  serve.ts    serveStdio(opts): connects createMcpServer to stdio
packages/cli/src/main.ts      add the `mcp` command
packages/cli/package.json     add the SDK dependency
packages/cli/test/mcp/        guard.test.ts, watch.test.ts, tools.test.ts, harness.ts, e2e.test.ts
docs/SPEC.md, docs/NOTES.md   updated in Task 8
```

### Task 1: Method allowlist and guarded client

**Files:**
- Create: `packages/cli/src/mcp/guard.ts`
- Test: `packages/cli/test/mcp/guard.test.ts`

**Interfaces:**
- Consumes: `DaemonClient`, `daemonAt(home)` from `../daemon.ts`.
- Produces:
  ```ts
  export const ALLOWED_METHODS: readonly ["newRun","planShow","revise","run","status","explain","hint","cancel"];
  export type AllowedMethod = (typeof ALLOWED_METHODS)[number];
  export class NoDaemonError extends Error {}            // message = the daemon-down text from Global Constraints
  export type McpClient = { call(method: AllowedMethod, args: unknown[], cwd?: string): Promise<unknown> };
  export function guardedClient(connect: () => Promise<DaemonClient | undefined>): McpClient;
  ```

- [ ] **Step 1: Write the failing tests** in `guard.test.ts`:
  - `"allowlist is exactly the eight methods"`: `expect([...ALLOWED_METHODS]).toEqual([...])`.
  - `"every non-listed method throws before reaching the daemon"`: for `approvePlan, approveMerge, handoff, adopt, sync, follow, resume, "", "constructor"` (cast to `AllowedMethod`), `call` rejects with `/not allowed/` and the fake `DaemonClient.call` was never invoked.
  - `"allowed methods pass method, args and cwd through"`.
  - `"re-resolves the daemon on every call"`: `connect` returns `undefined` then a client; first call rejects with `NoDaemonError`, second succeeds.
- [ ] **Step 2: Run** `bun test packages/cli/test/mcp/guard.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement `guard.ts`.** Check membership with `ALLOWED_METHODS.includes`, not an object lookup (so `"constructor"` is rejected).
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Commit** `feat(cli): mcp method allowlist and guarded daemon client` (files: guard.ts, guard.test.ts).

### Task 2: SDK, server skeleton, `heph mcp`, binary smoke test

De-risks the two unknowns first: SDK works with zod 4, and survives `bun build --compile`.

**Files:**
- Modify: `packages/cli/package.json` (dependency), `packages/cli/src/main.ts` (command `mcp`)
- Create: `packages/cli/src/mcp/server.ts`, `packages/cli/src/mcp/serve.ts`, `packages/cli/test/mcp/harness.ts`
- Test: `packages/cli/test/mcp/tools.test.ts` (initial: server identity and empty-until-Task-4 tool list is not asserted yet)

**Interfaces:**
- Consumes: `McpClient` (Task 1).
- Produces:
  ```ts
  // server.ts
  export type McpCtx = { client: McpClient; workspace: () => string | undefined; now?: () => number; sleep?: (ms: number) => Promise<void> };
  export function createMcpServer(ctx: McpCtx): McpServer;     // name "heph", version from ../version.ts
  // serve.ts
  export async function serveStdio(o: { home: string; workspace: () => string | undefined }): Promise<void>; // resolves when the transport closes
  // harness.ts (tests only)
  export async function connectTestClient(ctx: McpCtx): Promise<Client>; // SDK Client over InMemoryTransport.createLinkedPair
  export function fakeDaemon(handlers: Partial<Record<AllowedMethod, (args: unknown[], cwd?: string) => unknown>>): { client: McpClient; calls: { method: string; args: unknown[]; cwd?: string }[] };
  ```

- [ ] **Step 1: Add the dependency.** Find the newest `@modelcontextprotocol/sdk` release at least two weeks old (`bun pm view @modelcontextprotocol/sdk time`), add it exactly pinned to `packages/cli/package.json`, `bun install`. Confirm `McpServer`, `StdioServerTransport`, `InMemoryTransport`, `Client` import and that the version's `registerTool` accepts a zod raw shape. If the pinned version's API differs from `registerTool(name, {description, inputSchema}, handler)`, adapt Tasks 4-6 to it; the tests do not change.
- [ ] **Step 2: Write the failing test** `"server identifies itself as heph"`: `connectTestClient` then `client.getServerVersion()?.name === "heph"`.
- [ ] **Step 3: Run** it — FAIL.
- [ ] **Step 4: Implement** `server.ts` (no tools yet), `serve.ts` (guardedClient over `daemonAt(home)`, `StdioServerTransport`, await `onclose`; log to stderr only), `harness.ts`, and the `mcp` entry in `COMMANDS` in `main.ts` (`run`: `serveStdio({ home: homeOf(ctx), workspace: () => { try { return workspaceOf(ctx) } catch { return undefined } } })`, `render: () => ""`, `usage: ["mcp", "Serve heph to a chat host over MCP (stdio); the host starts this"]`).
- [ ] **Step 4b:** `bun test packages/cli/test/mcp`, `bun run typecheck`, `bun run lint` — all pass.
- [ ] **Step 5: Compiled-binary smoke.** Run `bun run build:heph`, then
  `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' | dist/heph mcp --home "$(mktemp -d)"`
  Expected: one JSON line with `"serverInfo":{"name":"heph"...}` on stdout; nothing else on stdout. If the compile fails or zod 4 is rejected by the SDK, stop and report before continuing (the design's first risk).
- [ ] **Step 6: Commit** `feat(cli): heph mcp serves an empty MCP server over stdio` (package.json, bun.lock, main.ts, mcp/*, tests).

### Task 3: Milestone long-poll (`watchStep`)

**Files:**
- Create: `packages/cli/src/mcp/watch.ts`
- Test: `packages/cli/test/mcp/watch.test.ts`

**Interfaces:**
- Consumes: `isMilestone`, `watchLine`, `WatchEvent`, `WatchView` from `../watch.ts` (unchanged).
- Produces:
  ```ts
  export type Outcome = "running"|"awaiting_plan_approval"|"waiting_for_you"|"planner_escalated"|"staged"|"finished"|"failed";
  export type WatchStepResult = { run_id: string; status: string; lines: string[]; cursor: string | undefined; outcome: Outcome };
  export async function watchStep(id: string, view: WatchView, o: {
    since?: string; waitMs: number; intervalMs?: number; retries?: number; heartbeatMs?: number;
    sleep?: (ms: number) => Promise<void>; now?: () => number; onLine?: (line: string) => void;
  }): Promise<WatchStepResult>;
  ```
  `cursor` is the largest event id of all events seen (ULIDs sort by time), `undefined` when the run has no events.

- [ ] **Step 1: Write failing tests** (scripted view as in `watch.test.ts`, injected `sleep`/`now`):
  - catch-up (no `since`): first line is `"<id>: <status>"`, then the last 3 milestones, cursor = newest event id.
  - with `since`: only milestones with id greater than `since`; non-milestone events never appear.
  - returns early with `lines` as soon as a poll finds a new milestone (does not wait `waitMs`).
  - returns after `waitMs` with `outcome: "running"` and a heartbeat line (`"<unit>/aN still working, M min into this attempt"` when an attempt is open, else `"<id>: still running"`) when nothing new happened and the silence exceeds `heartbeatMs`.
  - outcome mapping, each returning immediately: `planned` + unapproved → `awaiting_plan_approval`; `escalated` → `planner_escalated`; `paused` with last `run.paused` summary containing `waiting for you` → `waiting_for_you`; `staged` → `staged`; `finished` → `finished`; `failed` → `failed`; `paused` (rate limit) and `built` and `running` → `running`.
  - `waitMs: 0` polls exactly once.
  - Review Focus 3: `status` throwing on the first N calls then recovering → result is normal; throwing more than `retries` times → rejects with the last error.
  - `onLine` receives each returned line as it is found.
- [ ] **Step 2: Run** `bun test packages/cli/test/mcp/watch.test.ts` — FAIL.
- [ ] **Step 3: Implement `watchStep`.** Same polling and classification as `watchRun` in `src/watch.ts` (read it; copy the status-to-outcome mapping and heartbeat text, do not import or modify `watchRun`). Default `intervalMs` 2000, `retries` 30.
- [ ] **Step 4: Run** the test — PASS. `bun run typecheck && bun run lint`.
- [ ] **Step 5: Commit** `feat(cli): mcp watchStep, a cursor-based long-poll of run milestones`.

### Task 4: Read-only tools (`heph_plan_show`, `heph_status`, `heph_explain`) and shared plumbing

**Files:**
- Create: `packages/cli/src/mcp/tools.ts`, `packages/cli/src/mcp/text.ts`
- Modify: `packages/cli/src/mcp/server.ts` (call `registerTools`)
- Test: `packages/cli/test/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `McpCtx`, `connectTestClient`, `fakeDaemon` (Task 2); `OUTPUT` from `../output.ts`.
- Produces:
  ```ts
  // tools.ts
  export function registerTools(server: McpServer, ctx: McpCtx): void;
  // internal helper used by every tool: runs a daemon call, parses `data` with OUTPUT[command], returns
  // { content: [{type:"text", text}], structuredContent } or { isError: true, content: [{type:"text", text: error.message}] }
  // text.ts
  export const planText: (p: PlanResultLike) => string; export const planShowText, statusText, explainText, ...
  ```
- Inputs: `heph_plan_show { run: string }` → `planShow`; `heph_status { run?: string }` → `status` (args `[]` or `[run]`); `heph_explain { run: string, unit?: string }` → `explain`.

- [ ] **Step 1: Write failing tests:**
  - listing tools includes the three names with descriptions (tool-list assertion for the full set comes in Task 6).
  - `heph_plan_show`: fake `planShow` returns a valid `PlanShow` payload; result `structuredContent` equals it, text contains each task id and the line `next:` mentioning "the user approves the plan (heph approve plan <run>) — never approve it yourself" when `approved` is false.
  - `heph_status` with no run → daemon called with `("status", [])`; with run → `[run]`; both shapes of `OUTPUT.status` accepted.
  - `heph_explain` passes `unit` only when given.
  - Review Focus 2: fake `status` throws `"unknown run r9"` → `isError: true`, text `"unknown run r9"`.
  - fake client throwing `NoDaemonError` → `isError` with the daemon-down text.
  - daemon payload that fails `OUTPUT` parsing → `isError` text starting `"unexpected daemon answer"` (schema drift is visible, not silent).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the helper and the three tools (zod raw-shape inputs, `.describe()` on every field since the model reads them), renderers in `text.ts` in the CLI's words (see `renderPlan`/`tasksText` in `main.ts` for wording; do not import from `main.ts`).
- [ ] **Step 4: Run** tests, typecheck, lint — PASS.
- [ ] **Step 5: Commit** `feat(cli): mcp read-only tools heph_plan_show, heph_status, heph_explain`.

### Task 5: Mutating tools (`heph_new`, `heph_plan_revise`, `heph_hint`, `heph_cancel`)

**Files:**
- Modify: `packages/cli/src/mcp/tools.ts`, `packages/cli/src/mcp/text.ts`
- Test: `packages/cli/test/mcp/tools.test.ts`

**Interfaces:**
- Consumes: Task 4 helper; `Brief` from `@hephaestus/core`.
- Inputs:
  - `heph_new { brief: object, workspace?: string, on?: string }` → `newRun(brief, { on })` with cwd = `workspace` or `ctx.workspace()`; result `OUTPUT.new`.
  - `heph_plan_revise { run, instructions }` → `revise(run, instructions)`; `OUTPUT["plan revise"]`.
  - `heph_hint { run, unit, text, scope?: string[], budget?: number }` → `hint(run, unit, text, { scope, budget })`; `OUTPUT.hint`.
  - `heph_cancel { run }` → `cancel(run)`; `OUTPUT.cancel`.

- [ ] **Step 1: Write failing tests:**
  - `heph_new` happy path: daemon receives `newRun` with the brief and cwd; text has the task list and a `next:` line saying to show the plan to the user and wait for them to run `heph approve plan <run>` themselves; escalated/failed `PlanResult` renders the reason.
  - Review Focus 1: a Brief missing `goal` → `isError`, text names `goal`, `newRun` never called; `brief` passed as a string → `isError` "brief must be an object"; no workspace resolvable and no `workspace` arg → `isError` naming the directory problem and the `workspace` argument.
  - `workspace` argument overrides `ctx.workspace()` as the cwd passed to the daemon.
  - `heph_hint` omits `scope`/`budget` keys when absent.
  - `heph_plan_revise` and `heph_cancel` map to the right method and render their results.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Validate with `Brief.safeParse` before calling the daemon and format the zod issues as `path: message` lines.
- [ ] **Step 4: Run** tests, typecheck, lint — PASS.
- [ ] **Step 5: Commit** `feat(cli): mcp tools heph_new, heph_plan_revise, heph_hint, heph_cancel`.

### Task 6: `heph_run` and `heph_watch`, tool-set safety assertions

**Files:**
- Modify: `packages/cli/src/mcp/tools.ts`, `packages/cli/src/mcp/text.ts`
- Test: `packages/cli/test/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `watchStep` (Task 3), `ctx.sleep`/`ctx.now` for tests.
- Produces results (not in `OUTPUT`; define their zod schemas next to the tools):
  - `heph_run { run }` → `{ run_id, state: "awaiting_plan_approval" | "started" | "already_running", status, lines: string[], cursor?: string }`.
  - `heph_watch { run, since?: string, wait_s?: number }` → `WatchStepResult` (Task 3). Emits `notifications/progress` for each new line when the request carried a `progressToken`.

- [ ] **Step 1: Write failing tests:**
  - Review Focus 4: `status` says `planned`, `plan_approved: false` → `state: "awaiting_plan_approval"`, the fake records **no** `run` call, text says to ask the user to run `heph approve plan <run>`.
  - approved plan → `run` called once; daemon answers `{started: true, after}` → `state: "started"` with `lines`/`cursor` from a `watchStep` with `waitMs: 0`; daemon answers `{started: false, running: true}` → `state: "already_running"`, not `isError`.
  - daemon `run` rejecting (e.g. "the planner escalated r1; see heph explain r1") → `isError` with that message.
  - `heph_watch`: passes `since`; clamps `wait_s` (`-3` → 0, `999` → 25, absent → 20), checked via the injected `sleep`/`now` or the `waitMs` seen by a stubbed step; returns outcome text with `next:` per outcome (`waiting_for_you` and `planner_escalated`: "explain to the user and ask; do not retry"; `staged`: "tell the user to review, then run `heph approve merge <run>` themselves").
  - progress: with a progress token, an in-memory client receives one `notifications/progress` per returned line (message = the line); without a token, none, and the result is identical.
  - **Safety:** `listTools` names equal exactly the nine expected names; none matches `/approve/i`; after calling every tool once, the fake's recorded methods are all in `ALLOWED_METHODS`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** both tools. `heph_run` reads status via the guarded client (`status`, `[run]`) before deciding.
- [ ] **Step 4: Run** the whole `bun test packages/cli/test/mcp`, typecheck, lint — PASS.
- [ ] **Step 5: Commit** `feat(cli): mcp tools heph_run and heph_watch`.

### Task 7: End-to-end over stdio against a real daemon

**Files:**
- Create: `packages/cli/test/mcp/e2e.test.ts`, `packages/cli/test/mcp/daemon-fixture.ts` (copy the ~25-line `startDaemon`/`put` helpers from `packages/cli/test/daemon.test.ts` rather than exporting them from that file)

**Interfaces:**
- Consumes: `bun packages/cli/src/main.ts daemon|mcp`, the `HEPH_DEPS_MODULE` fixture and `HEPH_TEST_WORKER_MS` as `daemon.test.ts` uses them; the SDK's `StdioClientTransport`.

- [ ] **Step 1: Write the test.** In a temp home/workspace (set up as `daemon.test.ts` does): start a daemon; spawn `heph mcp` via `StdioClientTransport` (`command: "bun"`, args `[MAIN, "mcp", "--home", home, "--workspace", ws]`); then
  1. `listTools` has the nine tools.
  2. `heph_new` with a valid brief → run id and tasks; `heph_plan_show` shows it unapproved.
  3. `heph_run` → `awaiting_plan_approval`; `heph_status` for the run still `planned`.
  4. Approve through the CLI `run(["approve","plan",id])` (the test plays the user).
  5. `heph_run` → `started`; loop `heph_watch` (`wait_s: 5`, feeding back `cursor`) until `outcome` is `staged`, `finished` or `failed`; expect not `failed`.
  6. Review Focus 5: capture the server's stdout through a second raw `Bun.spawn` of `heph mcp` (send `initialize`, `tools/list`) and assert every stdout line parses as JSON with `jsonrpc: "2.0"`.
  7. Stop the daemon mid-test in a separate case: `heph_status` → `isError` with the daemon-down text; restart it; the next call succeeds on the same server process.
- [ ] **Step 2: Run** `bun test packages/cli/test/mcp/e2e.test.ts` — FAIL until the daemon-fixture helper exists, then PASS; fix real bugs found, not the test.
- [ ] **Step 3: Full suite** `bun test && bun run typecheck && bun run lint` — PASS; rerun the Task 2 compiled-binary smoke on a fresh `bun run build:heph`.
- [ ] **Step 4: Commit** `test(cli): mcp end to end over stdio against a real daemon`.

### Task 8: Docs

**Files:**
- Modify: `docs/SPEC.md` (section 16 "MCP server"), `docs/NOTES.md` (section "Following a run from the chat host")

- [ ] **Step 1: Update SPEC section 16 "MCP server"** to as-built: `heph mcp` over stdio, underscore tool names (and why), the nine tools including `heph_watch`, the allowlist guarantee and its limit (same-user processes can still reach the socket; out-of-band approval is v1.5), daemon required, `heph_run` never waits for approval. Keep the `heph.approve` v1.5 line, renamed `heph_approve`.
- [ ] **Step 2: Update NOTES**: replace "Not built: MCP progress notifications..." with what was built and the decision (pull tool as the contract, notifications best-effort), the duplicated outcome mapping and the follow-up to extract a shared `watchStep` once the stall-detection change in `watch.ts` lands, and the follow-ups left out (installer registering the server with hosts; skill/AGENTS.md paragraph preferring the tools, which must change in both files together).
- [ ] **Step 3: Commit** `docs: the MCP server as built`.
