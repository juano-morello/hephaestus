# MCP server design

Status: draft for review (2026-11-05). Implements SPEC section 16 "MCP server". `heph.approve` stays out (v1.5).

## Goal

Let a chat host (Claude Code, Codex, any MCP client) drive heph through typed tools instead of shell commands: submit a Brief, show and revise the plan, start the build, follow it, explain, hint, cancel. It is a thin adapter: no engine logic, no new daemon behavior. The MCP can never approve anything.

## Decisions (from the brainstorm)

| Question | Decision |
|---|---|
| Transport | stdio only. The host spawns `heph mcp`; no port, no token, nothing new to attack. |
| Packaging | `heph mcp` subcommand of the compiled binary, so the server always matches the installed daemon. |
| Backend and safety | Daemon client only, behind a hardcoded method allowlist. No in-process fallback. |
| `heph.run` and progress | `run` is non-blocking; a cursor-based pull tool reports milestones. MCP progress notifications are best-effort only. |
| Workspace for `new` | The directory the host launched `heph mcp` in (same `findWorkspace` as the CLI), with an optional `workspace` argument. |

## Approaches considered

1. **stdio adapter over the daemon socket (chosen).** Reuses `daemonAt`/`DaemonClient`, runs as the user, builds outlive the chat because the daemon owns them.
2. In-process runtime when no daemon answers (the CLI's fallback). Rejected: a build would die with the MCP process, and the engine would load into a long-lived server for no benefit.
3. HTTP served by the daemon. Rejected for now: puts an agent-reachable endpoint on the process that owns approvals. Revisit with MCP Apps widgets (v1.5), which will need HTTP and its own auth design.

Progress: (a) blocking `run` streaming notifications, rejected because hosts that hide progress show a frozen call and long calls hit timeouts; (b) status/explain only, rejected because there is no cheap incremental feed; (c) non-blocking `run` plus a pull tool (chosen).

## Architecture

Location: `packages/cli/src/mcp/`, not a new package. The server needs `daemon.ts` (client), `output.ts` (payload schemas) and `watch.ts` (milestones), all in `packages/cli`; a separate `packages/mcp` would depend on cli while cli depends on it to register `heph mcp`, a cycle. A directory inside cli keeps one build and one version. (Deviation from "likely a new package"; confirm in review.)

```
packages/cli/src/mcp/
  server.ts     createMcpServer({ client, workspace }): registers tools, no I/O of its own
  guard.ts      ALLOWED methods + guardedClient(client): throws on anything else
  tools.ts      one definition per tool: input zod, daemon call, text renderer, structured result
  watch.ts      single-step milestone feed (cursor, long-poll) over status + explain
  serve.ts      stdio entry: find daemon, build server, connect StdioServerTransport
main.ts         registers `heph mcp` (the only edit outside mcp/)
```

Dependency: `@modelcontextprotocol/sdk`, pinned exactly (version at least two weeks old, per repo convention), bundled by `bun build --compile`. Verify first in the plan that the compiled binary starts and answers `initialize` over stdio and that the SDK accepts the repo's zod 4.

### Safety: the MCP never approves

The daemon's `/call` runs any host method, `approvePlan` and `approveMerge` included, so the guarantee lives in the adapter:

- `guard.ts` wraps the `DaemonClient` so only these methods are callable: `newRun`, `planShow`, `revise`, `run`, `status`, `explain`, `hint`, `cancel`. Everything else (`approvePlan`, `approveMerge`, `handoff`, `adopt`, `sync`, `follow`, `resume`) throws before reaching the socket.
- There is no approve tool, and tool results only ever say "ask the user to run `heph approve plan <run>` themselves".
- Tests: the registered tool list equals the expected set (no name containing `approve`); the guard rejects every non-listed method; a tool wired to a fake client records only allowlisted calls.
- Not defended here: any process of the same user (including an agent with shell access) can still call the socket directly. The Claude Code deny rule covers `heph approve` in Bash only. Closing this is the v1.5 out-of-band approval work and needs a caller identity on `/call`; it is out of scope.

## Tools

Tool names use underscores (`heph_new`, not `heph.new`): Claude's API restricts tool names to `[a-zA-Z0-9_-]`, so dots would be rewritten or rejected by some hosts. SPEC section 16 gets updated to match when this ships.

| Tool | Input | Daemon call | Result |
|---|---|---|---|
| `heph_new` | `brief` (object, validated with core `Brief`), `workspace?`, `on?` | `newRun` | `PlanResult`: run id, tasks, or escalation; `next` hint |
| `heph_plan_show` | `run` | `planShow` | `PlanShow` |
| `heph_plan_revise` | `run`, `instructions` | `revise` | `PlanResult` |
| `heph_run` | `run` | `status`, then `run` | see below |
| `heph_watch` | `run`, `since?`, `wait_s?` | `status`, `explain` | milestones since a cursor, see below |
| `heph_status` | `run?` | `status` | `StatusList` or `StatusOne` |
| `heph_explain` | `run`, `unit?` | `explain` | `Explain` |
| `heph_hint` | `run`, `unit`, `text`, `scope?`, `budget?` | `hint` | `Hint` |
| `heph_cancel` | `run` | `cancel` | `Cancelled` |

Every result carries text first (short, with a `next:` line, in the CLI's words) and `structuredContent` matching the `OUTPUT` schema of the equivalent CLI command, so the JSON contract is shared and versioned once (`schema: 1`). Failures are `isError` results with the daemon's message.

### `heph_run`

Never blocks. Reads status first:
- plan not approved: starts nothing and returns `{ state: "awaiting_plan_approval", next: "ask the user to run heph approve plan <run>" }`. (The CLI waits for approval in a loop; a tool call must not.) The model calls `heph_run` again after the user approves.
- plan approved: calls daemon `run`, returns `{ state: "started", cursor, catch_up: [...] }`.
- already running or finished: returns the current state with the same shape, so retrying is safe.

### `heph_watch`

One step of what `heph watch` does in a loop. Input `since` is an event id (a ULID cursor, same as `watch.ts`); omitted means "catch up": status plus the last 3 milestones. It long-polls on the server for up to `wait_s` (default 20, max 25, below typical host timeouts) and returns as soon as there are new milestones or the run needs attention.

Result: `{ run_id, status, lines: string[], cursor, outcome }` where `outcome` is one of `running`, `awaiting_plan_approval`, `waiting_for_you`, `planner_escalated`, `staged`, `finished`, `failed`. Anything other than `running` is a stop for the model: explain to the user and ask, never retry (same rule as the skill). Lines come from `isMilestone` and `watchLine` in `packages/cli/src/watch.ts`, imported unchanged. The heartbeat ("still working, N min into this attempt") is included when a long-poll ends with no news, so the model can tell alive from dead.

Terminal classification (the ~15 lines in `watchRun` that map status to outcome) is duplicated in `mcp/watch.ts` rather than refactored out of `watch.ts`, because the stall-detection stream is editing that file. Follow-up once it lands: extract a shared `watchStep` and have both use it.

### Progress notifications

While `heph_watch` long-polls, if the client sent a `progressToken`, emit `notifications/progress` with each new milestone line as `message`. Hosts that show them get live output; hosts that drop them lose nothing, because the same lines are in the result. Nothing depends on notifications reaching the model. (`NOTES` open point: hosts differ; this is the answer.)

## Startup and errors

- `heph mcp [--home <dir>] [--workspace <dir>]` resolves home as the CLI does (`--home`, `$HEPH_HOME`, `~/.heph`).
- If no daemon answers at start, the server still starts (so the host shows it as connected) and every tool returns an `isError` result: "heph daemon is not running: start it with `heph daemon`, or rerun `bun run install:heph`". The daemon is re-checked on each call, so starting it later just works.
- `heph_new` without a findable workspace: error naming the directory searched and the `workspace` argument.
- Brief schema errors come back as the core validator's message, not a stack trace.
- stdout is the protocol channel: all logging goes to stderr.

## Testing

- Unit, with the SDK's in-memory transport pair and a fake `DaemonClient`: tool list, input validation, one call per tool maps to the right method and arguments, `heph_run` branches (unapproved, started, already running), error shapes.
- `guard.ts`: allowlist exact, every denied method throws, no call reaches the client.
- `mcp/watch.ts`: cursor semantics, catch-up, long-poll returns early on news and at `wait_s`, each `outcome`, using injected `sleep`/`now` as `watch.test` does.
- Integration: start a real daemon on a temp home (as existing daemon tests do), connect an SDK client over stdio to `heph mcp`, run `heph_status` and the unapproved `heph_run` path.
- Compiled-binary smoke test added to the build verification: `heph mcp` answers `initialize`.

## Out of scope

- `heph_approve`, elicitation, out-of-band approval, MCP Apps widgets, HTTP transport (v1.5).
- Engine or daemon changes; handoff/adopt/sync tools (node plumbing, not agent actions).
- Installer registering the server with hosts (`claude mcp add heph -- heph mcp`, Codex `config.toml`). Follow-up, together with a skill/AGENTS.md paragraph telling the agent to prefer the tools when present and fall back to the CLI plus `heph watch` otherwise (a test keeps those two files identical, so they change together).

## Risks

- SDK size and zod 4 compatibility in the compiled binary: checked first thing in the plan.
- Tool-name rule (underscores) departs from SPEC wording; SPEC edited at implementation.
- Long-poll length versus host tool timeouts: `wait_s` capped at 25 and configurable down.
