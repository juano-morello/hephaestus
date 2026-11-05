# Dashboard: a read-only web view of runs and the run graph

Status: design, awaiting review. Date: 2026-11-05.

## Problem

Following a run means reading `heph status`, `heph explain` or `heph watch` text. A build with
parallel units, retries and gate failures is hard to see that way. SPEC section 16 plans a views
bundle served by the daemon that powers `heph ui` (and, later, MCP Apps widgets). Nothing of it
exists: the daemon listens on a Unix socket only, so a browser cannot reach it.

## Goals and constraints

- First slice only: a **read-only** web dashboard with a runs list and a run page (unit graph,
  attempts, gate results). Widgets, ledger charts, plan review, diff summary and retro are later
  slices that reuse the same bundle.
- The browser can never approve, run, cancel, hint or create anything. Approvals stay v1.5 and
  out-of-band (SPEC "Approvals").
- No ledger or event schema change; no projection version bump.
- Works from the installed single binary (`bun build --compile`); no Node/npm at runtime.
- Local node only. A run owned by another node shows as the daemon already reports it (possibly
  stale, as for `heph status`); no cross-node dashboard.

## Design

### Transport

The daemon (`packages/cli/src/daemon.ts`) gains an HTTP listener next to its Unix socket.

- Binds `127.0.0.1:7878`. If the port is taken it binds an OS-chosen port and logs it. The
  actual port is written to `$HEPH_HOME/ui.json` (`{ port, token }`, mode 0600).
- The token is generated once (random 32 bytes, base64url) and kept in `ui.json` across daemon
  restarts, so a bookmarked URL keeps working.
- `heph ui` reads `ui.json`, prints `http://127.0.0.1:<port>/#t=<token>` and opens the browser.
  The token travels in the URL fragment (never sent to the server, not logged); the page moves
  it to `sessionStorage` and sends it as `Authorization: Bearer <token>` on API calls. With no
  daemon answering, `heph ui` exits 1 and says to run `heph doctor`.
- Routes: `GET /` and `/assets/*` (the bundle, no token needed, it holds no data) and
  `POST /api/<method>` (token required).
- Every request's `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, else 403
  (DNS rebinding). No CORS headers are sent. Cross-origin requests fail the bearer check.

### Read-only allowlist

`/api/` routes only `status`, `explain`, `planShow` and `dashboard`. Any other method name is a
404, whether or not the daemon has it. A test asserts the allowlist is exactly this set and
contains none of `newRun`, `revise`, `run`, `hint`, `cancel`, `approve*`, `merge*`, `handoff`,
`adopt`, `sync`. The MCP server's method allowlist is the model; the HTTP one is stricter
(it has no `hint`, `cancel` or `run`).

### New read method: `dashboard`

One call returning what the run page needs, so the browser does not stitch four calls:

`dashboard(run_id)` -> `{ schema: 1, run, plan: { units: [{ id, project, kind, depends_on }] },
units: [{ id, status, attempts: [{ n, status, model, gates: [{ gate, pass, reason?, evidence? }] }] }],
pauses, stack_on, usage }`, all derived from the existing projections and events. A list view
uses `status` with no argument (already returns every run). The output schema goes in
`packages/cli/src/output.ts` with the others.

### Package and build

New package `packages/ui` (React 19, TypeScript). `bun build` bundles it to `dist/ui/`; the CLI
embeds those files (Bun `with { type: "file" }` imports) so `bun build --compile` carries them,
and the daemon serves them from memory.

- **Radix UI** primitives for behavior and accessibility (Tabs, Collapsible, Tooltip,
  ScrollArea, Dialog where needed).
- **animate-ui** components (they are copy-in source built on Radix and `motion`, not a package
  to install): copied into `packages/ui/src/components/animate-ui/` and kept as our code.
- **uiverse.io** elements are copy-paste CSS/HTML snippets: used sparingly for status badges
  and loaders, ported to React components with their license note kept in the file header.
- **Tailwind CSS** (needed by animate-ui), compiled at build time to one stylesheet.
- State: plain React hooks and one small polling hook; no state library.

### Look

Dark and light themes from CSS variables, three accents:

| Role | Color | Use |
|---|---|---|
| Forest green | `#228B22`-family, a deeper `#1F5F3B` for surfaces | primary, accepted units, healthy status |
| Sand beige | `#E8DCC4`-family | light-theme background, text on dark, neutral chrome |
| Electric purple | `#8A2BE2`-family | focus rings, selection, running/in-flight, links |

Failure and escalation need a signal color outside the three; use a warm red/amber that reads on
both themes (decided at build time against contrast, WCAG AA text). Status is never conveyed by
color alone (icon plus label).

### Views

- **Runs** (`/`): table of runs: id, status, workspace, stacked-on, updated. Row opens the run.
- **Run** (`/#/run/<id>`): header with status, pause reason, stack parent, usage. Body is the
  unit graph (SVG: nodes by status, edges from `depends_on`, layered left to right, running
  nodes pulse). Selecting a unit opens a side panel with its attempts and, per attempt, gate
  results (gate, pass/fail, reason, evidence in a collapsible).
- **Live updates:** poll `status` every 2 s while any run is `running`, 10 s otherwise; the run
  page polls `dashboard` the same way. No SSE in this slice. Polling pauses when the tab is
  hidden.
- Error states: daemon unreachable (banner with retry), bad token (page says to run `heph ui`
  again), unknown run (404 view).

## Testing

- Daemon HTTP: token missing/wrong -> 401; wrong Host -> 403; every non-allowlisted method ->
  404 with the real handler never called; allowlist equals the expected set; the port-taken
  fallback writes the real port to `ui.json`; the token persists across a restart.
- `dashboard` output validates against its schema on fixture ledgers (parallel run, stalled unit,
  stacked child).
- Views: render tests (happy-dom + Testing Library) from fixture `dashboard` payloads: graph
  layout, selected-unit panel, error states.
- Smoke script: daemon on a temp home, fetch `/`, then `/api/status` with and without a token.
- Bundle-in-binary check: the compiled `heph` serves `/` without the repo present.

## Not in this slice

Approve/hint/cancel/run buttons; plan review, changeset diff and ledger-chart views; retro;
MCP Apps widgets (they will reuse the bundle and the same allowlist); SSE; remote-node
dashboards; auth beyond the local token.

## Risks

- A new local network surface. Mitigated by loopback bind, token, Host check, read-only
  allowlist; any process of the same user can still read `ui.json` and the socket, as today.
- Binary size grows by the bundle (hundreds of KB, small against 124 MB).
- animate-ui and uiverse components are copy-in: their license and upgrade story is ours to keep.
