# Dashboard views and the token challenge (2026-11-07)

Sub-project E (dashboard and widgets) of `docs/ROADMAP.md`, the read-only slice: a security fix for the dashboard token, then plan review, a changeset diff summary and ledger charts. Write actions, SSE, remote-node dashboards and MCP Apps widgets are deliberately not part of this.

## Problem

Checked in the source on 2026-11-07:

- `heph ui` opens `http://127.0.0.1:<port>/#t=<token>` after checking that the daemon answers and that the page is a 200 containing `<div id="root">`. A foreign process holding the port (when the daemon's listener did not start or died, leaving a stale `ui.json`) can serve exactly that page and receive the token, which reads every run: briefs, plans and gate evidence (NOTES, Dashboard follow-up a).
- The dashboard shows a runs list and a run page (graph, unit panel, attempts and gate results). It has no plan review, no view of what a run changed, and no charts. The API behind it is a 4-method read allowlist (`status`, `explain`, `planShow`, `dashboard`); `planShow` returns only a task summary, attempt diffs exist only as ledger blobs, and per-attempt tokens are not rolled up.

## Decisions (2026-11-07)

- Scope: the security fix plus the read-only views (chosen over adding hint and cancel buttons, over adding remote dashboards and SSE, and over everything but MCP Apps).
- Diff summary: a file list with added and removed line counts per unit and project; no diff text crosses the listener (chosen over inline diffs and over links only).
- Charts: per-run charts plus an overview strip on the runs page (chosen over per-run only, and over adding a gate statistics panel).
- Token proof: a challenge-response, so the token never goes to an unproven listener.
- Out of scope, recorded as decided-not-now: hint and cancel buttons (writes are 404 even with the token; needs a write-surface design), SSE (polling works), remote-node dashboards, MCP Apps widgets with an HTTP transport (host support is an open SPEC question), provider usage versus limits (no quota signal), a gate statistics panel.

## 1. The token fix

- The listener gets an unauthenticated `GET /challenge?nonce=<value>`: the nonce is URL-safe, 16 to 128 characters (anything else is a 400); the loopback `Host` check still applies. It answers `{ "hmac": hex(HMAC-SHA256(key = token, data = "heph-ui-v1:" + nonce)) }`. The token is never sent.
- `heph ui`, after its existing checks, generates a random nonce, calls `/challenge`, and compares the answer with its own HMAC using `timingSafeEqual`. A mismatch fails with `the dashboard listener on port N is not this node's daemon (a stale ui.json?); restart it with heph daemon, or run heph doctor`. The URL with the token is built only after the check passes.
- `ui.json` is trusted by `heph ui` and by the daemon only when it is owned by the current user and not readable by group or others (the daemon's mode check gains the owner check).
- Remaining window: between the challenge and the browser opening the URL, another process could take the port only if the daemon's listener died in that moment; the token is read-only and the exposure is documented.
- Folded in from earlier follow-ups: the temp file for `ui.json` is created exclusively (`wx`, unique name); a raw chunked-body test for the size limit; a test for the failure path of `startUiServer`; the graph's `statuses[id]` lookup stops reading inherited keys.

## 2. The read-only API

Four new read methods, added to the listener's allowlist (8 methods; every write method stays a 404 even with the token). Each returns a versioned shape defined in `packages/cli/src/output.ts`, with the UI's mirrored type and a fixture test, like `dashboard`.

- `planDetail(runId)`: the latest plan's tasks (id, title, kind, project, lane, complexity and its reason, scope, `creates`, `covers`, `produces`, `consumes`, spec), the risks, and the Brief's criteria with the tasks that cover them (including `check` and `projects`).
- `diffSummary(runId)`: for each unit's accepted attempt in the latest plan, its project and its changed files with added and removed counts, plus per-unit and per-project totals, computed on the daemon by a pure `summarizeDiff(text)` over the attempt's diff blob. A unit whose blob is missing is `unavailable`; a binary file is counted changed with 0 and 0 and flagged `binary`; an unparseable diff yields the files it could read plus `partial: true`. No diff text is returned.
- `runCharts(runId)`: per unit, its attempts in order with outcome, tier, model, tokens and duration; tokens by model and role; counts of escalations and stalls.
- `overview()`: across all runs on this node: runs by status, total tokens by model, escalation and stall counts.

Data: `diffSummary` uses the `unit.attempt.finished` diff blobs and the `unit.accepted` events; the charts use the existing `attempts` and `runs` projections plus counting `unit.escalated` and `unit.stalled` events. No schema, event or projection changes. The methods read this node's ledger, so a run owned by another node shows the synced copy with the `stale` field `dashboard` already carries.

## 3. The views

- The run page becomes four Radix tabs: **Graph** (today's page, unchanged), **Plan**, **Changes**, **Charts**. A tab fetches its data when first opened and refreshes on the page's existing polling while the run is active.
  - Plan: one card per task (title, kind, project, lane, complexity with its reason, scope, `creates`, `covers`, `produces`, `consumes`, spec collapsed), the risks, and a criteria table showing which tasks cover each criterion with `check` and `projects` marked.
  - Changes: per unit and project, the changed files with `+added -removed` counts and totals; `unavailable`, `binary` and `partial` are said in words.
  - Charts: attempts per unit with an outcome glyph per attempt (red, green, blocked, error), tokens by model as horizontal bars, and the escalation and stall counts.
- The runs page gets a summary strip above the table: runs by status, total tokens by model, escalation and stall counts.
- Charts are hand-rolled SVG and HTML bars, no chart library. Status is never color alone, every chart has a visually hidden data table, and every color pair goes through the existing contrast script (4.5:1 for text, 3:1 for non-text).

## 4. Docs and rollout

- SPEC §16 gets an as-built paragraph (the views, the read methods, the challenge); NOTES gets "Dashboard views and token challenge (2026-11-07)" and marks follow-ups (a), (b) and the `statuses[id]` item fixed; ROADMAP's E line and the decided-not-now list are updated.
- No ledger event, schema or projection changes; the bundle is rebuilt with `bun run build:ui`.

## Testing

- `summarizeDiff`: a normal diff, a rename, a new file, a deleted file, a binary file, an empty diff, garbage input.
- Each new method against a ledger built from the existing dashboard test fixtures; the allowlist test (8 methods allowed; `hint`, `cancel`, `approvePlan` and any other method still 404 with a valid token); the type-mirror fixture test gains the new shapes.
- The challenge answers correctly and rejects bad nonces; `heph ui` refuses a foreign listener that serves the root element and accepts the real one; a world-readable or foreign-owned `ui.json` is not trusted; the exclusive create, chunked body and `startUiServer` failure tests. These bind loopback ports, which the agent sandbox blocks (`EPERM`), so verifying them needs a run outside the sandbox.
- UI component tests (happy-dom, run from `packages/ui`) with fixtures for each tab and the strip, including the existing reduced-motion and contrast checks. A real-browser look at the new tabs is manual and stays unverified unless run by the user.

## Not changed

Writes (still off the network), the polling model, the runs and run page's existing behavior, and ledger events and projections.
