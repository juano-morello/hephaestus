# Known issues

Gotchas, limits and things left unbuilt on purpose. Each: what, why it is like that, what would reopen it. Fixed items are deleted, not struck through. Long form in `NOTES.md`.

## Engine and gates

- A syntax error counts as a "red" for a test unit. A right-reason red needs per-stack test-output parsing. Reopen: seen causing a wrong accept in a real run. [NOTES "Built-in gates", "Deferred"]
- The Return's scope is not narrowed to the failing files. Reopen: seen in real runs. [NOTES "Deferred"]
- Stall detection misses near-duplicate signatures and plan-level stalls (different units failing alike). [NOTES "Following a run"]
- Native sandbox: a SIGKILL of heph leaves the command's process group running until it ends; there is no record to find it by. Container mode labels and reaps containers. [NOTES "Resume and idempotency"]
- Coverage delta and a TS `defineGate` are not built; use custom command gates (recipes in NOTES, untested). [SPEC §11]

## Runs and nodes

- Wrong tree: workers inspected `main` instead of their worktree. Cause unconfirmed; the native sandbox confines tool `cwd` but reads the whole filesystem, so the worker prompt now names the worktree and says not to look at `main`. Reopen: it happens again (then confine reads or give workers a checkout with no path to the main one).
- Remaining-budget tracking per provider and fallback on provider outages are not built (needs worker failure classes). [NOTES "Routing"]
- Cancel across processes without a daemon, Ctrl-C in `heph run`, and aborting a gate command on cancel are not built or not verified. [NOTES "Handoff wait"]
- An MCP call that times out (10 s, or 30 s for `heph_run`) may still have started the build; calling `heph_run` again answers `already_running`. [NOTES "MCP server: follow-ups"]
- The CLI's `heph watch` retries every daemon error and its daemon calls have no timeout, on purpose. [same]
- Handoff refuses a peer whose reported build (`git describe`) differs; `heph sync` and doctor only warn. A node run from source reports `<describe>, from source`, so it never matches a compiled one. Reopen: false refusals between source and compiled builds of one commit.
- Stacking: a run always starts from its target; building on another run's branch needs the earlier one merged. [NOTES "Stacking"]

## Measurement

- `heph eval` has not run live against the private suite; the planner-gate before/after measurement is still owed. [progress.md, NOTES "Measuring the planner gates"]
- `heph stats` cannot see manual edits after a PR opens, or work done in direct sessions that never went through heph.

## Environment

- The live widgets' direct read does not work in Claude desktop (checked 2026-11-10): the host passes `connect-src=http://127.0.0.1:<port>` to its widget proxy, but the widget document's own CSP stays `connect-src 'self' <stable origin> blob: data:`, so every fetch to the dashboard is blocked. It likely accepts https origins only. The widget keeps the last view and says so; it still redraws on each `heph_status`/`heph_watch` call, and live updates work where the host has `serverTools` (Codex). Reopen: Claude desktop honors an http loopback connect domain, or the dashboard serves https with a certificate the host accepts. The note's CSP hint can miss, because the violation event fires after the fetch rejects.
- heph cannot build this repo yet: its gate runs `bun run test` in heph's own sandbox, where 63 tests fail (nested sandbox-exec, daemon ports) and the suite takes about 8 minutes. Reopen: a container sandbox for this repo, or a test command that skips them.
- Run the test suites with the Claude sandbox off (`dangerouslyDisableSandbox`): `sandbox-exec` cannot nest, and `packages/cli` shows about 60 false failures otherwise.
- macOS with Colima only mounts `$HOME`, so container-mode worktrees must live under it. [NOTES "OMP worker in a sandbox"]
