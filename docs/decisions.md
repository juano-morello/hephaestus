# Decisions

Settled decisions, one line each: date, decision, why. Do not reopen one without asking the owner. Long-form reasoning stays in `NOTES.md` (section named in brackets). Newest at the bottom; append, do not rewrite.

## Planner and gates

- 2026-11-03: every test-checked criterion an implement task covers needs its own preceding same-project test. Why: one overlap was too loose. [NOTES "Spec interpretations"]
- 2026-11-03: implement tasks with empty `covers` fail; support work must serve a criterion. [same]
- 2026-11-03: criteria only a gate can check use `check: { gate }`, not an invented test task. Why: the planner had to fabricate round-trip tests for "buf lint passes". [same, item 4]
- 2026-11-03: the planner gets an honest exit (`escalate`), like workers' `blocked`. Why: contradictory Briefs always became plans that passed the gates (0/15 escalations before, 9/9 after). [same, item 16]
- 2026-11-03: the engine stamps `brief_hash` and drops `null` optional fields before parsing. Why: an LLM cannot compute sha256, and `null` for optional fields kept failing zod. [same, items 13, 17]
- 2026-11-03: attempt branches are `heph-attempt/<run>/<unit>/a<n>`, the changeset branch stays `heph/<run>`. Why: git cannot hold both a branch and a directory of branches at one ref. [NOTES "Engine"]
- 2026-11-05: a unit stalls (pauses for the user) when its last two red attempts fail the same way, threshold fixed at 2. Why: more attempts cannot fix a structural failure. [NOTES "Following a run"]
- 2026-11-07: custom gates are commands run in the sandbox, not TS files. Why: repo TS would run in the engine process, which holds git push and secrets. [NOTES "Custom command gates"]
- 2026-11-10: a `test` task may set `expect: "green"` (default red) for characterization tests and refactor pins; the tests gate then requires a pass. Why: red-before-green rejected pure refactors. The planner and test-author prompts say when.

## Runtime and limits

- 2026-11-04: sandbox default is `native`, not container. Why: no per-project images, network allowlist or dependency caches yet. [NOTES "Ready to use"]
- 2026-11-05: `limits.parallel` defaults to 3, tune later. [NOTES "Stacking and parallel fan-out"]
- 2026-11-05: no multi-parent stacking and no cross-node runners until a real need appears (diamond-shaped runs, one machine's CPU as the bottleneck). [same]
- 2026-11-06: leases and heartbeats, v1.5 approvals and the npm scope are out of scope for now. [progress.md]
- 2026-11-09: the attempt timeout (`limits.attempt_timeout_ms`, 20 min) and gate timeout (10 min) are the only time limits; both are config, not per run. A run has no wall-clock cap.
- 2026-11-10: `limits.gate_timeout_ms_by_tier` overrides the gate timeout by the task's complexity; still config, no per-run override. Why: parallel runs share the CPU and a heavy suite outgrew 10 minutes; the 2026-11-09 decision stands.
- 2026-11-10: handoff refuses a peer whose reported build differs when both are known; `version` stays 0.1.0 so the build (`git describe`) is what is compared. Why: a stale denver rejected newer event fields.

## Surfaces

- 2026-11-07: dashboard and widgets are read-only; approve, hint and cancel buttons wait for a write-surface design. Approve never goes through the chat or MCP. [NOTES "Dashboard views", "MCP Apps run widget"]
- 2026-11-07: retro, the constraint store and learned routing wait for a few dozen closed runs in `heph stats`; until then, use the `reflect` skill. [SPEC §15, NOTES "Eval runner and stats"]

- 2026-11-10: the widgets read the daemon's read-only dashboard themselves, polling every 2 s (direct polling, not SSE); the MCP result's `_meta.heph.live` gives origin and token (loopback only, never in the text the model reads) and the widget resource declares it in `connectDomains`. The dashboard answers CORS for `/api/*` only; the token still gates every call. Why: Claude desktop lets no widget call tools, and a server cannot push into a widget. This changes the 2026-11-07 "no CORS" stance for /api and keeps SSE not built.

## Process

- 2026-11-09: no attribution (Co-Authored-By, "Generated with") in commits or PRs. [CLAUDE.md]
- 2026-11-09: every Brief acceptance criterion names a runnable check (a test, or a gate via `check`). [heph skill]
