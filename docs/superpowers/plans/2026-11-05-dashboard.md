# Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only web dashboard (runs list, run page with unit graph, attempts and gate results) served by the daemon on `127.0.0.1:7878` and opened by `heph ui`.

**Architecture:** The daemon gains an HTTP listener (token, Host check, four-method read allowlist) that serves a React bundle embedded in the compiled `heph` binary. A new read method `dashboard` returns everything the run page needs from existing projections and events. The bundle polls the API; there are no new events, no projection bump, and no mutating route.

**Tech Stack:** Bun, TypeScript, React 19, Radix UI, animate-ui (copy-in source), uiverse.io snippets (copy-in), Tailwind CSS, happy-dom + Testing Library for view tests, zod (existing).

**Spec:** `docs/superpowers/specs/2026-11-05-dashboard-design.md`

## Global Constraints

- Read-only: `/api/` routes exactly `status`, `explain`, `planShow`, `dashboard`; no other method is reachable.
- Listener binds `127.0.0.1:7878`; if taken, an OS-chosen port; the real port goes to `$HEPH_HOME/ui.json` (`{ port, token }`, mode 0600).
- Token: random 32 bytes base64url, generated once and kept across restarts; sent as `Authorization: Bearer <token>`; carried in the URL fragment (`/#t=<token>`), never the query string.
- `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, else 403. No CORS headers.
- No ledger event schema change; no `PROJECTION_VERSION` bump.
- Works from the compiled single binary (`bun build --compile`) with no Node/npm at runtime.
- Palette: Forest green (primary, accepted, healthy), Sand beige (light background, neutral chrome), Electric purple (focus, selection, running, links); a separate warm red/amber for failed/escalated; status never by color alone; text contrast WCAG AA.
- Polling: `status` / `dashboard` every 2 s while any run is `running`, else 10 s; paused while the tab is hidden.
- Code style: biome (2 spaces, width 100), `bun test`, TypeScript strict. Commit messages carry no attribution lines.

## Review Focus

- A run with no plan yet (`created`, planning, planner `escalated`): `dashboard` returns empty `plan.units`, not an error; the page says "no plan yet".
- Units with attempts that are not in the latest plan (a revised plan): shown, marked "not in current plan", never dropped or thrown on.
- Malformed request (non-JSON body, huge body, wrong content type) on `/api/*`: 400 with a message, daemon keeps serving.
- A stale `ui.json` (daemon killed, port dead): `heph ui` reports "daemon not running" instead of printing a dead URL.
- Port 7878 taken by another process: daemon still starts (socket works), UI listens on a fallback port, `ui.json` is truthful; if no listener can start, the daemon logs it and runs on without a UI.
- Run ids with characters that need escaping (`/`, `#`, spaces) in the hash route: the page decodes them and the API call carries the exact id.
- A cyclic or self-referencing `depends_on` (shouldn't happen, must not hang): layout terminates and still renders every node.

---

### Task 1: `dashboard` read method and its schema

**Files:**
- Modify: `packages/cli/src/runtime.ts` (add `dashboard` next to `status`/`explain`, ~line 606-650)
- Modify: `packages/cli/src/host.ts` (add `case "dashboard"` beside `planShow`/`explain`, ~line 392)
- Modify: `packages/cli/src/output.ts` (add `Dashboard` schema, export it)
- Test: `packages/cli/test/dashboard.test.ts`

**Interfaces:**
- Produces: `rt.dashboard(runId: string): Dashboard` and daemon/api method `"dashboard"` taking `[runId]`; `Dashboard` zod schema and type exported from `output.ts`:
  `{ schema: 1, run: RunRow, plan_approved: boolean, plan: { units: { id, title, kind, project, depends_on: string[] }[] }, units: { unit_id, status, attempts: number, in_plan: boolean }[], attempts: { unit_id, attempt, status, model?, provider?, outcome?, duration_ms?, gates: { gate, verdict, reason, evidence: string[] }[] }[], pauses: string[], stack_on?: { run_id, status }, usage, stale?: string }`.
- Consumes: `ledger.units/attempts/usage/read`, `deriveEdges` from `@hephaestus/core`, existing `latestPlan`, `runRow`, `approvedPlan` in `runtime.ts`.

- [ ] **Step 1: Write the failing tests** in `packages/cli/test/dashboard.test.ts`, using the fixtures/helpers the other cli tests use (`lifecycle.test.ts` shows a run built on a temp workspace with scripted workers). Tests, named exactly:
  - `dashboard of a planned run lists plan units with depends_on from consumes/produces` — assert `plan.units.map(u => u.id)` equals the plan's task ids and a consumer's `depends_on` contains its producer.
  - `dashboard attaches gate results to the attempt that produced them` — a run with one red attempt: `attempts[0].gates` has an entry with `verdict: "fail"` and its `reason`.
  - `dashboard of a run with no plan yet has empty plan.units` — a `created` run: `plan.units` is `[]`, no throw.
  - `dashboard keeps units that are not in the latest plan` — revise the plan after an attempt; the dropped unit has `in_plan: false`.
  - `dashboard output validates against the Dashboard schema` — `Dashboard.parse(rt.dashboard(id))` for each fixture above.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/cli/test/dashboard.test.ts`
Expected: FAIL (`rt.dashboard is not a function`).

- [ ] **Step 3: Implement `dashboard(runId: string)` in `runtime.ts`** and the `Dashboard` schema in `output.ts` (`.strict()`, like its neighbours). Build `plan.units` from `latestPlan(runId).plan.tasks` (empty when `run.plan_ready` was never written) with `depends_on` from `deriveEdges(tasks).edges` grouped by `to`. Take `units`, `attempts`, `usage`, `stack_on` exactly as `status` does (reuse by extracting the shared part rather than duplicating it). Group `gate.result` events (`ledger.read({ run_id, types: ["gate.result"] })`) by the event's `unit_id` and `attempt`. `pauses` is the reasons of the run's `run.paused` events since its latest `run.resumed`.

- [ ] **Step 4: Wire `case "dashboard"` in `host.ts`**, identical to the `planShow`/`explain` branch (refresh the run from its owner, then `rt.dashboard(runId)`), adding `stale` when the owner is unreachable as `status` does.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test packages/cli/test/dashboard.test.ts && bun run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src packages/cli/test/dashboard.test.ts
git commit -m "feat(cli): dashboard read method for the run page"
```

---

### Task 2: The daemon's UI listener (token, Host check, allowlist, ui.json)

**Files:**
- Create: `packages/cli/src/ui-server.ts`
- Modify: `packages/cli/src/daemon.ts` (`startDaemon` starts it; `Daemon` type gains `ui?: { port: number }`; `stop()` stops it)
- Test: `packages/cli/test/ui-server.test.ts`

**Interfaces:**
- Produces:
  - `export const UI_METHODS = ["status", "explain", "planShow", "dashboard"] as const`
  - `export const DEFAULT_UI_PORT = 7878`
  - `export const uiFileOf = (home: string) => join(home, "ui.json")`
  - `export type UiAssets = Record<string, { body: BlobPart; type: string }>` keyed by path (`"/"`, `"/assets/app.js"`, ...)
  - `export async function startUiServer(o: { home: string; call: (method: string, args: unknown[]) => Promise<unknown>; assets: UiAssets; port?: number; log?: (line: string) => void }): Promise<{ port: number; token: string; stop(): Promise<void> } | undefined>` (undefined when no listener could bind; logs why).
  - `export function readUiFile(home: string): { port: number; token: string } | undefined`
- Consumes: `host.api.call(method, args, cwd)` through the `call` option (cwd undefined).

- [ ] **Step 1: Write the failing tests** in `ui-server.test.ts` (temp `home`, a fake `call`, tiny fake `assets`; port `0` to avoid collisions except the fallback test). Names:
  - `serves the bundle without a token` — `GET /` returns the fake index, `GET /assets/app.js` the fake script.
  - `api without a token is 401, with a wrong token is 401`
  - `a wrong Host header is 403` — `Host: evil.example:7878` on both `/` and `/api/status`.
  - `only the four read methods are routable` — for each of `newRun revise run hint cancel approve merge handoff adopt sync` `POST /api/<m>` is 404 and the fake `call` is never invoked; `UI_METHODS` equals the four names.
  - `an allowlisted method passes args and returns data` — `POST /api/status` with `{ "args": ["r-1"] }` calls `call("status", ["r-1"])`, answers `{ ok: true, data }`; a thrown error answers `{ ok: false, error: { message } }` with status 200 (same shape as the daemon socket).
  - `a non-JSON or oversized body is 400 and the server keeps serving` — 2 MB body and `not json`, then a good request still answers.
  - `GET /api/status is 405`.
  - `no CORS headers on any response`.
  - `ui.json is written with mode 0600 and the real port` — `(statSync(file).mode & 0o777) === 0o600`.
  - `the token survives a restart` — stop, start again with the same home, same token.
  - `a taken port falls back to another and ui.json says which` — occupy a port with `Bun.serve`, ask for it, expect a different `port` in the result and in `ui.json`.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/cli/test/ui-server.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `startUiServer`** with `Bun.serve({ hostname: "127.0.0.1", port, fetch })`. Order of checks per request: Host (403) -> route. Static routes need no token; `/api/<m>` requires `POST` (405 otherwise), then the bearer token compared with `crypto.timingSafeEqual` (401), then the allowlist (404), then body parse limited to 1 MB (400). Token: read from `ui.json` if present and valid, else `randomBytes(32).toString("base64url")`. Write `ui.json` with `writeFileSync(..., { mode: 0o600 })` and `chmodSync` after (umask). If binding the requested port throws `EADDRINUSE`, retry with port `0`; if that throws too, log and return `undefined`.

- [ ] **Step 4: Wire into `startDaemon`.** It takes a new option `uiAssets?: UiAssets`; when given, call `startUiServer({ home, call: (m, a) => host.api.call(m, a, undefined), assets, log })`, log `dashboard on http://127.0.0.1:<port>`, and stop it in `stop()`. `ui.json` is not removed on stop (the token must persist), so consumers of `readUiFile` verify liveness themselves (Task 3). `daemon.ts` itself imports no assets; `main.ts` passes them (Task 6).

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test packages/cli/test/ui-server.test.ts packages/cli/test/daemon.test.ts && bun run typecheck`
Expected: PASS; existing daemon tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/ui-server.ts packages/cli/src/daemon.ts packages/cli/test/ui-server.test.ts
git commit -m "feat(cli): read-only dashboard listener in the daemon"
```

---

### Task 3: `heph ui`

**Files:**
- Modify: `packages/cli/src/main.ts` (new `ui` command in `COMMANDS`; add to usage text)
- Modify: `packages/cli/src/output.ts` (`OUTPUT.ui` schema `{ url: string, opened: boolean }`)
- Test: `packages/cli/test/ui-command.test.ts`

**Interfaces:**
- Consumes: `readUiFile`, `daemonAt` (`daemon.ts`), the `command({ run, render, usage })` shape used by `mcp`/`daemon`.
- Produces: `heph ui [--no-open]` printing `http://127.0.0.1:<port>/#t=<token>`; `--json` returns `{ url, opened }`.

- [ ] **Step 1: Write failing tests:**
  - `heph ui prints the url from ui.json when the daemon answers` — start a real daemon via the helper in `daemon.test.ts` (copy its `startDaemon`/`heph` helpers into a shared `test/helpers.ts` only if used by two files), run `ui --no-open --json`, assert `url` matches `^http://127\.0\.0\.1:\d+/#t=[\w-]+$` and equals the daemon's `ui.json`.
  - `heph ui with no daemon fails and says to run heph doctor` — `ok: false`, message contains `heph doctor`.
  - `heph ui with a stale ui.json fails the same way` — write a `ui.json` with a dead port and no daemon; same failure, no URL printed.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/cli/test/ui-command.test.ts`
Expected: FAIL (unknown command `ui`).

- [ ] **Step 3: Implement the command.** Liveness: `daemonAt(home)` must answer and `fetch(http://127.0.0.1:<port>/)` must return 200 within 1 s. Open the browser with `Bun.spawn(["open", url])` on darwin and `["xdg-open", url]` elsewhere, only when stdout is a TTY and `--no-open` is absent; a spawn failure is not an error (`opened: false`). `usage: ["ui [--no-open]", "Open the read-only dashboard in your browser"]`.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test packages/cli/test/ui-command.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): heph ui opens the dashboard"
```

---

### Task 4: `packages/ui` scaffold, build, theme, API client, polling

**Files:**
- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/scripts/build.ts`, `packages/ui/src/index.html`, `packages/ui/src/main.tsx`, `packages/ui/src/app.tsx`, `packages/ui/src/theme.css` (Tailwind entry + CSS variables), `packages/ui/src/api.ts`, `packages/ui/src/use-poll.ts`, `packages/ui/test/setup.ts`, `packages/ui/test/api.test.ts`, `packages/ui/test/use-poll.test.tsx`
- Modify: root `package.json` (scripts `build:ui`; `typecheck` and `build:heph` run it first; add `packages/ui` to the `tsc -b` list), `bunfig.toml` (create: test preload for happy-dom)
- Create: `packages/cli/src/ui-assets.ts`
- Modify: `packages/cli/src/main.ts` (pass `uiAssets` to `startDaemon`)

**Interfaces:**
- Produces:
  - `api.ts`: `createApi(o: { base?: string; token: () => string | undefined; fetch?: typeof fetch }): { call<T>(method: "status" | "explain" | "planShow" | "dashboard", ...args: unknown[]): Promise<T> }`; throws `ApiError` with `kind: "unauthorized" | "unreachable" | "daemon"` (401 -> unauthorized, network failure -> unreachable, `ok: false` -> daemon with the message).
  - `readToken(): string | undefined` — takes `#t=<token>` from `location.hash` once, stores it in `sessionStorage`, then rewrites the hash to keep only the route.
  - `usePoll<T>(fn: () => Promise<T>, o: { fastMs: number; slowMs: number; fast: (v: T | undefined) => boolean }): { data?: T; error?: ApiError; loading: boolean }` — re-polls at `fastMs` while `fast(data)`, else `slowMs`; does nothing while `document.hidden`; clears its timer on unmount.
  - `ui-assets.ts`: `export const uiAssets: UiAssets` with `/` (index.html), `/assets/app.js`, `/assets/app.css`, built from `packages/ui/dist/` via `import x from "../../ui/dist/app.js" with { type: "file" }` so `bun build --compile` embeds them.
- Consumes: `UiAssets` (Task 2).

- [ ] **Step 1: Scaffold the workspace package.** Add dependencies with `bun add --exact` inside `packages/ui`: `react`, `react-dom`, `@radix-ui/react-tabs`, `@radix-ui/react-collapsible`, `@radix-ui/react-tooltip`, `@radix-ui/react-scroll-area`, `motion`, `tailwindcss`, `@tailwindcss/cli`; dev: `@types/react`, `@types/react-dom`, `@testing-library/react`, `@happy-dom/global-registrator`. `build.ts` runs `bun build src/main.tsx --outdir dist --entry-naming app.[ext] --minify`, the Tailwind CLI for `theme.css` -> `dist/app.css`, and copies `src/index.html` (links `/assets/app.js` and `/assets/app.css`) to `dist/index.html`.

- [ ] **Step 2: Write failing tests:**
  - `api.test.ts`: `sends the bearer token and posts to /api/<method>`; `maps 401 to unauthorized`; `maps a fetch rejection to unreachable`; `maps ok:false to a daemon error with its message`; `readToken moves the fragment token into sessionStorage and leaves the route` (`/#t=abc` -> storage `abc`, hash `""`; `#/run/r-1&t=abc` is not supported, only a leading `t=`).
  - `use-poll.test.tsx` (fake timers via `setTimeout` injection or `bun:test` `jest.useFakeTimers` equivalent): `polls at fastMs while running and slowMs otherwise`; `does not poll while the document is hidden`; `stops after unmount`.

- [ ] **Step 3: Run to verify failure**

Run: `bun test packages/ui`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement `api.ts`, `use-poll.ts`, `theme.css`.** Theme: CSS variables `--forest`, `--sand`, `--purple`, `--danger`, surface/text tokens for light (sand background) and dark (deep forest background, sand text), defined on `:root`, overridden under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`, and under `:root[data-theme="dark"]`; Tailwind `@theme` maps them to utilities. Pick the exact hex values so body text meets 4.5:1 in both themes (check with a quick script in the build, failing the build if not).

- [ ] **Step 5: Implement `app.tsx`** as a hash router (`#/` runs list, `#/run/<encodeURIComponent(id)>` run page) rendering placeholder views, plus a banner component for `unreachable` ("the daemon is not answering, retrying") and `unauthorized` ("run `heph ui` again"). Implement `ui-assets.ts` and pass it from the `daemon` command in `main.ts`.

- [ ] **Step 6: Verify build, embed and the in-binary serving**

Run: `bun run build:ui && bun test packages/ui && bun run typecheck`
Expected: `packages/ui/dist/{index.html,app.js,app.css}` exist; tests PASS.

Run: `bun run build:heph && HEPH_HOME=$(mktemp -d) ./dist/heph daemon & sleep 2; curl -s http://127.0.0.1:7878/ | head -c 200`
Expected: the index.html (checked from a directory without the repo's `packages/ui`); then stop the daemon.

- [ ] **Step 7: Commit**

```bash
git add package.json bunfig.toml packages/ui packages/cli/src bun.lock
git commit -m "feat(ui): React bundle scaffold, theme, api client, embedded in the binary"
```

---

### Task 5: Runs list view

**Files:**
- Create: `packages/ui/src/views/runs.tsx`, `packages/ui/src/components/status-badge.tsx`
- Modify: `packages/ui/src/app.tsx` (route `#/` renders `Runs`)
- Create: `packages/ui/src/components/animate-ui/` (copy in the animate-ui components used: an animated list/row highlight; keep each file's license header)
- Test: `packages/ui/test/runs.test.tsx`, `packages/ui/test/fixtures.ts` (typed fixture payloads shared with Task 6)

**Interfaces:**
- Consumes: `createApi`, `usePoll` (Task 4); `StatusList`, `RunRow` shape (`run_id`, `status`, `stack_on?`, `owner_node`, `updated_at`).
- Produces: `StatusBadge({ status }: { status: string })` — icon + label + color per status (running purple pulse, staged/landed/finished green, paused/escalated amber, failed red, others neutral sand); `Runs()` component.

- [ ] **Step 1: Write failing tests** with a fake `api`: `lists every run with id, status badge and stacked-on parent`; `a row link points to #/run/<encoded id>`; `shows the daemon-unreachable banner when the call fails`; `shows "no runs yet" for an empty list`; `status badge always carries a text label, not just a color`.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/ui/test/runs.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the table (Radix `ScrollArea` for overflow, rows from `status` with no argument, `usePoll` fast = any run `running`). The uiverse.io loader/badge snippet for the running state is ported to `status-badge.tsx` with its license note in the file header. Row order: most recently updated first.

- [ ] **Step 4: Run tests**

Run: `bun test packages/ui && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): runs list"
```

---

### Task 6: Run page: graph layout, SVG graph, unit panel

**Files:**
- Create: `packages/ui/src/graph-layout.ts`, `packages/ui/src/views/run.tsx`, `packages/ui/src/components/unit-graph.tsx`, `packages/ui/src/components/unit-panel.tsx`
- Modify: `packages/ui/src/app.tsx` (route `#/run/<id>`), `packages/ui/test/fixtures.ts` (dashboard fixtures: parallel run, stalled unit, stacked child, no-plan run)
- Test: `packages/ui/test/graph-layout.test.ts`, `packages/ui/test/run.test.tsx`

**Interfaces:**
- Produces:
  - `layoutGraph(units: { id: string; depends_on: string[] }[]): { nodes: { id: string; x: number; y: number; layer: number }[]; edges: { from: string; to: string }[]; width: number; height: number }` — longest-path layering, left to right, nodes in a layer ordered by input order; ignores dependencies on unknown ids; breaks cycles (a back edge is dropped) so it always terminates and returns every node.
  - `UnitGraph({ layout, statuses, selected, onSelect })`, `UnitPanel({ unit, attempts })`, `Run({ id })`.
- Consumes: `Dashboard` type (Task 1; import the type from a copy in `packages/ui/src/types.ts` mirroring `output.ts` so the UI does not import `@hephaestus/cli`; a test asserts the fixtures parse with the real `Dashboard` schema).

- [ ] **Step 1: Write failing tests.**
  - `graph-layout.test.ts`: `a chain puts each unit one layer right of its dependency`; `independent units share layer 0`; `a diamond puts the join after both parents`; `a dependency on an unknown id is ignored`; `a two-node cycle terminates and returns both nodes`; `a self-dependency is ignored`; `no two nodes overlap`.
  - `run.test.tsx`: `renders one node per plan unit colored and labeled by status`; `selecting a unit shows its attempts and per-attempt gate results with reason and evidence collapsed until opened`; `a unit not in the current plan is labeled "not in current plan"`; `header shows pause reason, stacked-on parent and usage`; `a run with no plan shows "no plan yet"`; `an unknown run shows a not-found view`; `a run id with / # and spaces decodes from the hash and the api receives the exact id`.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/ui/test/graph-layout.test.ts packages/ui/test/run.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `layoutGraph`** (pure; no React). Then `unit-graph.tsx` as SVG (nodes are `<g role="button" tabindex=0>` with Enter/Space selecting; running nodes pulse via `motion`; accepted green, failed/escalated red-amber with an icon, running purple, pending sand outline). `unit-panel.tsx` uses Radix `Tabs` per attempt and `Collapsible` for evidence. `run.tsx` polls `dashboard` (fast while the run is `running`) and renders header, graph, panel; the selected unit lives in component state (and survives polls).

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `bun test packages/ui && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): run page with unit graph, attempts and gate results"
```

---

### Task 7: End to end, accessibility pass, docs

**Files:**
- Create: `packages/cli/test/ui-e2e.test.ts`
- Modify: `docs/SPEC.md` (section 16 "Dashboard and MCP Apps widgets": add an "As built" paragraph; section 19 step 3 built list; `heph ui` is no longer unbuilt), `docs/NOTES.md` (new "Dashboard (2026-11-05)" section: decisions, what is not built, how to rebuild the bundle), `README.md` (one line on `heph ui` if the README lists commands)

**Interfaces:** Consumes everything above; produces nothing new.

- [ ] **Step 1: Write the failing e2e test** `dashboard serves a real run end to end`: start the daemon (helper from `daemon.test.ts`) with the real embedded assets, create a run through `heph new` with the scripted worker, then `fetch` with the token from `ui.json`: `GET /` returns HTML; `POST /api/status` lists the run; `POST /api/dashboard` for it validates against `Dashboard`; `POST /api/approve` is 404; the same calls without the token are 401.

- [ ] **Step 2: Run to verify failure, then fix wiring** until it passes.

Run: `bun test packages/cli/test/ui-e2e.test.ts`
Expected: first FAIL if any wiring is missing, then PASS.

- [ ] **Step 3: Drive the real page once** in the built-in browser against a daemon with a run in the LegendsAO-style fixture (or the e2e fixture): runs list, run page, both themes (`colorScheme` light/dark), a 375 px width, keyboard-only selection of a unit. Fix anything broken; record what was checked (and what was not) in the NOTES section.

- [ ] **Step 4: Update SPEC and NOTES** as listed under Files. State what is not built (approve/hint/cancel buttons, plan review, diff summary and ledger-chart views, retro, widgets, SSE, remote-node dashboards) and the known risks from the spec.

- [ ] **Step 5: Full verification**

Run: `bun run typecheck && bun run lint && bun test`
Expected: all green (the sandboxed run may skip native-sandbox tests; say so if so).

- [ ] **Step 6: Commit**

```bash
git add -A packages docs README.md
git commit -m "docs: dashboard as built; end-to-end test"
```
