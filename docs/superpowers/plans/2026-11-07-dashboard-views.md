# Dashboard views and token challenge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `heph ui` proves the listener holds the real token before it hands the token over, and the dashboard gains plan review, a changeset diff summary and ledger charts (per run, plus an overview strip), all read-only.

**Architecture:** The listener gets an unauthenticated `/challenge` (HMAC of a nonce under the token); `heph ui` verifies it. Four new read methods (`planDetail`, `diffSummary`, `runCharts`, `overview`) are runtime methods, host cases and allowlist entries with zod output shapes in `packages/cli/src/output.ts`. The UI run page becomes tabs and the runs page gets a summary strip, with hand-rolled SVG/HTML charts.

**Tech Stack:** TypeScript on Bun, zod 4, React 19 + Radix Tabs + Tailwind 4 (`packages/ui`), `bun test` (the UI package runs from its own directory with happy-dom).

**Spec:** `docs/superpowers/specs/2026-11-07-dashboard-views-design.md`

## Global Constraints

- The listener's allowlist becomes exactly these 8 methods: `status`, `explain`, `planShow`, `dashboard`, `planDetail`, `diffSummary`, `runCharts`, `overview`. Every other method (writes included: `hint`, `cancel`, `approvePlan`, `handoff`, ...) stays a 404 even with a valid token.
- No diff text is ever returned by any method. `/challenge` never needs or logs the token; its nonce is URL-safe, 16 to 128 characters, else 400; the loopback `Host` check applies to it as to every path.
- No ledger event, schema or projection changes. Output shapes live in `packages/cli/src/output.ts` (zod, strict) with mirrored types in `packages/ui/src/types.ts` and a fixture test, as `Dashboard` does.
- Status is never color alone in the UI; every chart has a visually hidden data table; every new color pair passes `packages/ui/scripts/contrast.ts` (4.5:1 text, 3:1 non-text).
- No attribution of any kind in commit messages (project CLAUDE.md overrides any harness reminder).
- Test commands: backend `bun test <paths>` from the repo root; UI `bun test --cwd packages/ui`; rebuild the embedded bundle with `bun run build:ui`. Baseline in the agent sandbox: about 70 tests in `packages/cli` and `packages/engine` and 18 in `packages/workers` fail before this work, and tests that bind loopback ports (ui-server, ui-e2e, ui-command, daemon) fail with `EPERM` in the sandbox; those need one run outside the sandbox to verify. `packages/cli` tsc reports 2 errors about unbuilt ui assets until `bun run build:ui` has run. Compare against a baseline checkout; judge flaky heavy-suite failures by rerunning the file alone.

## Review Focus

- A foreign listener that serves the root element: `heph ui` refuses, and the foreign server received no `Authorization` header and no token in any URL. (Task 1)
- All write methods still 404 with a valid token; each new read method 401s without one. (Tasks 1, 2, 3, 4)
- `diffSummary` never returns diff text, copes with a missing blob, a binary file, a rename, and an oversized diff. (Task 2)
- A run with no plan, no attempts or no runs at all, and a unit id such as `constructor`: no crash, sensible empty views. (Tasks 3, 4, 5)
- Charts and tabs: data tables present, status carried by words and glyphs, `bun run build:ui` (with its contrast check) passes. (Task 5)

---

### Task 1: The token challenge and `ui.json` trust

**Files:**
- Modify: `packages/cli/src/ui-server.ts`, `packages/cli/src/main.ts` (the `ui` command, ~line 645)
- Test: `packages/cli/test/ui-server.test.ts`, `packages/cli/test/ui-command.test.ts`

**Interfaces:**
- Produces, in `ui-server.ts`: `challengeAnswer(token: string, nonce: string): string` returning `hex(HMAC-SHA256(key = token, data = "heph-ui-v1:" + nonce))`; `proveListener(o: { port: number; token: string; fetch?: typeof fetch }): Promise<boolean>` which sends a fresh random nonce (16 random bytes, base64url) to `GET http://127.0.0.1:<port>/challenge?nonce=<nonce>` with no headers beyond the defaults, and returns true only when the JSON answer's `hmac` equals `challengeAnswer(token, nonce)` (compare with `timingSafeEqual`); any error, timeout (1000 ms) or non-200 is false.
- The listener serves `GET /challenge` after the `Host` check and before the bearer check; a bad or missing nonce is a 400 `bad nonce`; the answer is `{ "hmac": "<hex>" }`.
- `heph ui` runs `proveListener` after its existing checks (daemon answers, page 200 and has the root element) and, when false, throws `the dashboard listener on port <port> is not this node's daemon (a stale ui.json?); restart it with heph daemon, or run heph doctor`; the URL with the token is built only after it returns true.
- `ui.json` is trusted (by `readUiFile`'s callers in the daemon's `trustedToken` and by `heph ui`) only when its mode has no group or other bits and `statSync(file).uid === process.getuid()` (skip the uid check when `process.getuid` is undefined).
- The temp file for `ui.json` is created exclusively: `writeFileSync(tmp, ..., { flag: "wx", mode: 0o600 })` with a name `.ui.json.<pid>.<random hex>.tmp`.

- [ ] **Step 1: Write failing tests** (use the harness the existing `ui-server.test.ts` and `ui-command.test.ts` use; they bind loopback ports):
  - `challengeAnswer` equals a known HMAC for a fixed token and nonce (compute the expected value in the test with `node:crypto`).
  - `GET /challenge?nonce=<20 chars>` on a started listener returns 200 and the right `hmac`; a 3-character nonce, a 200-character nonce, a missing nonce and a nonce with `/` are 400; `Host: evil.example` is 403; no bearer token is needed.
  - `proveListener` is true against a real listener and false against a foreign `Bun.serve` that serves `<div id="root">` for `/` and answers `/challenge` with a wrong hmac, and false against one that answers 404.
  - `heph ui` with a `ui.json` pointing at that foreign server: it throws the exact error above; and the foreign server recorded no `authorization` header and no request URL containing the token; with the real daemon listener it prints the URL (existing test).
  - `ui.json` readable by group or others is not trusted by the daemon's `trustedToken` (a fresh token is created); `heph ui` with such a file errors.
  - The write/other methods: `POST /api/hint` with a valid token is 404 (add if the existing allowlist test lacks it).
  - Folded-in gaps: a raw chunked request body over 1 MiB is a 400 (send it with `Transfer-Encoding: chunked` over a raw `Bun.connect` socket or `fetch` with a streamed body); `startUiServer` returns `undefined` and removes its temp file when writing `ui.json` fails (make `home` a path whose `ui.json` is a directory).
- [ ] **Step 2: Run** `bun test packages/cli/test/ui-server.test.ts packages/cli/test/ui-command.test.ts` (outside the sandbox if ports are blocked) → the new tests fail.
- [ ] **Step 3: Implement** the interfaces and the exclusive temp file.
- [ ] **Step 4: Run** the two files and `bunx tsc -b packages/cli` → pass.
- [ ] **Step 5: Commit** `cli: heph ui proves the dashboard listener before it hands over the token`.

---

### Task 2: `diffSummary`

**Files:**
- Create: `packages/cli/src/diff-summary.ts`
- Modify: `packages/cli/src/output.ts` (new `DiffSummary` schema), `packages/cli/src/runtime.ts` (a `diffSummary(runId)` method next to `dashboard`), `packages/cli/src/host.ts` (a `diffSummary` case like `dashboard`'s), `packages/cli/src/ui-server.ts` (`UI_METHODS`), `packages/ui/src/api.ts` (`ApiMethod`), `packages/ui/src/types.ts`
- Test: `packages/cli/test/diff-summary.test.ts`, `packages/cli/test/dashboard.test.ts` (or a new `views.test.ts`), `packages/cli/test/ui-server.test.ts`, `packages/cli/test/ui-fixtures.test.ts`

**Interfaces:**
- Produces: `summarizeDiff(text: string): { files: DiffFile[]; partial: boolean }` with `DiffFile = { path: string; added: number; removed: number; binary?: true; renamed_from?: string }`. It parses `diff --git a/<x> b/<y>` blocks: `path` is the `b/` path (the `a/` path for a deleted file), `renamed_from` from `rename from`/`rename to`, `binary` from `Binary files ... differ` or `GIT binary patch` (counts 0 and 0), `added` and `removed` count hunk lines starting `+` or `-` excluding the `+++` and `---` headers; text over `MAX_DIFF_BYTES = 5 * 1024 * 1024` is cut at that size and returns `partial: true`; text with no `diff --git` header returns `{ files: [], partial: text.trim() !== "" }`.
- `DiffSummary` (zod, strict, in output.ts): `{ schema: 1, run_id, units: [{ unit_id, project, attempt?, status: "ok" | "unavailable", partial?: boolean, files: DiffFile[], added, removed }], projects: [{ project, files, added, removed }], stale?: string }`. `Runtime.diffSummary(runId)` takes the latest plan's tasks (project per unit), the `unit.accepted` events since the latest plan (`e.unit_id`, `e.attempt`) and, for each, the `unit.attempt.finished` event of that unit and attempt: its `blobs.diff` hash is read with `ledger.blobs.getText`; a missing event or blob makes the unit `unavailable` with no files; unit totals sum their files; `projects` sums units per project. Units are in plan order; a unit never accepted is omitted. The host case mirrors `dashboard` (refresh, then merge a `stale` message when the owner is unreachable). `UI_METHODS` and `ApiMethod` gain `diffSummary`; the UI type mirrors the shape.

- [ ] **Step 1: Write failing tests.**
  - `summarizeDiff`: a two-file diff gives the right per-file counts and ignores `+++`/`---`; a rename with edits gives `renamed_from`; a new file counts only additions; a deleted file keeps its `a/` path and counts only removals; a binary file is `binary: true` with 0 and 0; an empty string gives `{ files: [], partial: false }`; garbage text gives `{ files: [], partial: true }`; a 6 MiB diff returns `partial: true` and still lists the files in its first 5 MiB.
  - Method tests with a ledger built the way `dashboard.test.ts` builds one (add a diff blob to the accepted attempt's `unit.attempt.finished`): accepted units appear with their files and totals, `projects` sums them, the output contains none of the diff's added or removed text (assert a distinctive added line is absent from `JSON.stringify` of the result), a unit whose blob is missing is `unavailable`, a run with no accepted unit has `units: []`, and the shape parses with the `DiffSummary` schema.
  - Listener: `diffSummary` with a token returns data; without one 401; `ui-fixtures.test.ts` covers the new UI type.
- [ ] **Step 2: Run** `bun test packages/cli/test/diff-summary.test.ts packages/cli/test/dashboard.test.ts packages/cli/test/ui-server.test.ts packages/cli/test/ui-fixtures.test.ts` → the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same files and `bunx tsc -b packages/cli packages/ui` → pass.
- [ ] **Step 5: Commit** `cli: diffSummary, a file-level summary of what a run changed`.

---

### Task 3: `planDetail`

**Files:**
- Modify: `packages/cli/src/output.ts`, `packages/cli/src/runtime.ts`, `packages/cli/src/host.ts`, `packages/cli/src/ui-server.ts`, `packages/ui/src/api.ts`, `packages/ui/src/types.ts`
- Test: `packages/cli/test/dashboard.test.ts` (or `views.test.ts`), `packages/cli/test/ui-server.test.ts`, `packages/cli/test/ui-fixtures.test.ts`

**Interfaces:**
- `PlanDetail` (zod, strict, output.ts): `{ schema: 1, run_id, plan_id, approved: boolean, tasks: [{ id, title, kind, project, lane, complexity, complexity_reason, scope: string[], creates: string[], covers: string[], produces: string[], consumes: string[], spec }], risks: string[], criteria: [{ id, text, kind, check?: string, projects?: string[], covered_by: string[] }], stale?: string }`. `Runtime.planDetail(runId)` reads the latest plan (`latestPlan`) and the run's Brief (`created(runId).brief`): optional task fields default to `[]`, `check` is the criterion's gate name, `covered_by` lists the ids of tasks whose `covers` include the criterion (in plan order). A run with no finished plan throws the same `has no finished plan` error `dryRun` uses. The host case mirrors `dashboard`; `UI_METHODS`, `ApiMethod` and the UI types gain `planDetail`.

- [ ] **Step 1: Write failing tests:** a run with a two-task plan returns every field (scope, `creates`, covers, produces and consumes defaulted to `[]` when the task omits them, the criterion's `check` and `projects` and its `covered_by`); a criterion nobody covers has `covered_by: []`; the result parses with the schema; a run with no plan fails with the error; the listener serves it with a token and 401s without; `ui-fixtures.test.ts` covers the type.
- [ ] **Step 2: Run** the test files → the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files and `bunx tsc -b packages/cli packages/ui` → pass.
- [ ] **Step 5: Commit** `cli: planDetail, the full plan and its criteria for review`.

---

### Task 4: `runCharts` and `overview`

**Files:**
- Modify: `packages/cli/src/output.ts`, `packages/cli/src/runtime.ts`, `packages/cli/src/host.ts`, `packages/cli/src/ui-server.ts`, `packages/ui/src/api.ts`, `packages/ui/src/types.ts`
- Test: `packages/cli/test/dashboard.test.ts` (or `views.test.ts`), `packages/cli/test/ui-server.test.ts`, `packages/cli/test/ui-fixtures.test.ts`

**Interfaces:**
- `RunCharts` (zod, strict): `{ schema: 1, run_id, units: [{ unit_id, attempts: [{ attempt, outcome?, tier?, model?, role?, input, output, duration_ms? }] }], tokens: [{ model, role, input, output, cache_read, cache_write }], escalations: number, stalls: number, stale?: string }`. Per-unit attempts come from the `attempts` projection rows of the run (attempt order; missing token columns count 0); `tokens` sums those rows by model and role (rows without a role use `""`); `escalations` and `stalls` count the run's `unit.escalated` and `unit.stalled` events since the run began.
- `Overview` (zod, strict): `{ schema: 1, runs: [{ status, count }], tokens: [{ model, input, output, cache_read, cache_write }], escalations: number, stalls: number }` across all runs on this node (status counts from the runs projection, tokens summed over all attempts by model, the two counts over all runs' events). `Runtime.runCharts(runId)` and `Runtime.overview()`; the host cases: `runCharts` mirrors `dashboard` (refresh, `stale`), `overview` takes no argument and no refresh. `UI_METHODS`, `ApiMethod` and the UI types gain both.

- [ ] **Step 1: Write failing tests:** a run with three units and mixed outcomes (a red then green, a stalled one, an escalated one) gives the right attempt lists, token sums by model and role, and counts; a run with no attempts gives empty arrays and zero counts; `overview()` over two runs sums correctly and an empty ledger gives empty arrays and zeros; both parse with their schemas; the listener serves both with a token and 401s without; `ui-fixtures.test.ts` covers the types.
- [ ] **Step 2: Run** the test files → the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files and `bunx tsc -b packages/cli packages/ui` → pass.
- [ ] **Step 5: Commit** `cli: runCharts and overview read methods`.

---

### Task 5: The views

**Files:**
- Modify: `packages/ui/src/views/run.tsx` (tabs), `packages/ui/src/views/runs.tsx` (summary strip), `packages/ui/src/components/unit-graph.tsx` and `packages/ui/src/views/run.tsx` (the `statuses` lookup), `packages/ui/src/theme.css` (only if a new token is needed)
- Create: `packages/ui/src/components/plan-review.tsx`, `packages/ui/src/components/changes.tsx`, `packages/ui/src/components/charts.tsx`, `packages/ui/src/components/overview-strip.tsx`
- Test: `packages/ui/test/plan-review.test.tsx`, `changes.test.tsx`, `charts.test.tsx`, `overview-strip.test.tsx`, `run.test.tsx`, `runs.test.tsx`, `fixtures.ts`

**Interfaces:**
- Consumes: the four new API methods and their UI types (Tasks 2 to 4); `usePoll`, `createApi`.
- The run page renders Radix `Tabs` with tabs **Graph** (today's content, unchanged and the default), **Plan**, **Changes**, **Charts**; inactive tab content is not mounted, so each tab component fetches with `usePoll` when it first opens (polling on the same fast/slow rule as the page while the run is `running`).
  - `PlanReview({ id, api })`: one card per task (title, kind, project, lane, complexity and its reason, scope, `creates`, `covers`, `produces` and `consumes` as labeled lists, spec inside a Radix Collapsible), the risks, and a criteria table (id, text, `check` or `projects` marked in words, `covered_by` ids; an empty `covered_by` shown as "not covered").
  - `Changes({ id, api })`: per unit its project and files as `path +added -removed` (a `renamed from` note, a `binary` word, `unavailable` and `partial` said in words), unit totals, and per-project totals.
  - `Charts({ id, api })`: attempts per unit as a row of glyph-and-word outcome marks (green `✓`, red `✗`, blocked, error, none yet), tokens by model as horizontal bars (SVG or styled divs, with the number printed), the escalation and stall counts; every chart has a visually hidden `<table>` with the same data.
  - `OverviewStrip({ api })` above the runs table: runs by status, total tokens by model, escalation and stall counts, from `overview`; hidden when the call fails (the page's existing banner shows errors).
- The graph's `statuses[id]` lookups use `Map` or `Object.hasOwn` so a unit id like `constructor` reads as pending.

- [ ] **Step 1: Write failing tests** (happy-dom; fixtures typed with the UI types; render with an `Api` stub returning fixtures): each tab shows its content from fixtures and fetches nothing until opened (spy on the stub); the Plan tab shows "not covered" for an uncovered criterion and marks `check`/`projects` in words; the Changes tab shows `+3 -1`-style counts, the words `binary`, `unavailable`, `partial`, a rename note, and never any diff text; the Charts tab prints token numbers, has a data table, shows outcomes as words with glyphs, and renders with zero attempts; the strip renders status counts and is absent when `overview` rejects; a unit id `constructor` in the graph statuses renders as pending; all existing `run.test.tsx` and `runs.test.tsx` cases still pass (the Graph tab is the default). `contrast.test.ts` still passes.
- [ ] **Step 2: Run** `bun test --cwd packages/ui` → the new tests fail.
- [ ] **Step 3: Implement** the components and tabs; reuse existing tokens in `theme.css` and `StatusBadge`; no chart library.
- [ ] **Step 4: Run** `bun test --cwd packages/ui`, then `bun run build:ui` (it runs the contrast check and rebuilds the embedded bundle), `bunx tsc -b packages/ui packages/cli`, and `bunx biome check --write packages/ui packages/cli` → pass.
- [ ] **Step 5: Commit** `ui: plan review, changes and charts tabs, and an overview strip`.

---

### Task 6: Docs

**Files:**
- Modify: `docs/SPEC.md` (§16 Dashboard and MCP Apps widgets), `docs/NOTES.md` (new section "Dashboard views and token challenge (2026-11-07)"; mark follow-ups (a), (b) and the `statuses[id]` item in "Dashboard (2026-11-05)" as fixed; update its "Not built" line), `docs/ROADMAP.md` (sub-project E)

- [ ] **Step 1: Update the docs.** SPEC §16: the as-built paragraph for the 8-method allowlist, the four new read methods and their shapes in one line each, the `/challenge` handshake and `ui.json` ownership rule, and the Plan, Changes and Charts tabs and overview strip; widgets list marks run graph, plan review, diff summary and ledger charts built, retro proposals and provider usage versus limits not built. NOTES: the decisions, the allowlist, no diff text leaves the daemon, the challenge and its residual window, the test notes (loopback-binding tests need a run outside the agent sandbox; a real-browser look at the new tabs is manual and unverified), what is decided-not-now (hint and cancel buttons need a write-surface design first because writes are 404 even with the token, SSE, remote-node dashboards, MCP Apps widgets and an HTTP MCP transport pending host support and an auth design, provider usage versus limits, a gate statistics panel), and the fixed follow-ups. ROADMAP E: the read-only slice built, with the decided-not-now list.
- [ ] **Step 2: Run** `bun test packages/cli/test/ui-server.test.ts packages/cli/test/ui-command.test.ts packages/cli/test/dashboard.test.ts packages/cli/test/diff-summary.test.ts packages/cli/test/ui-fixtures.test.ts` (outside the sandbox where ports are needed) and `bun test --cwd packages/ui`, then compare `bun test packages/cli packages/engine packages/workers` failures with a baseline checkout of the starting commit (rerun flaky files alone) → no new failures. Run `bunx biome check --write packages` and `bunx tsc -b packages/core packages/workers packages/engine packages/cli packages/ui`.
- [ ] **Step 3: Commit** `docs: dashboard views and the token challenge as built`.
