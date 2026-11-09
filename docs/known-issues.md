# Known issues

Gotchas, limits and things left unbuilt on purpose. Each: what, why it is like that, what would reopen it. Fixed items are deleted, not struck through. Long form in `NOTES.md`.

## Engine and gates

- A syntax error counts as a "red" for a test unit. A right-reason red needs per-stack test-output parsing. Reopen: seen causing a wrong accept in a real run. [NOTES "Built-in gates", "Deferred"]
- The Return's scope is not narrowed to the failing files. Reopen: seen in real runs. [NOTES "Deferred"]
- Stall detection misses near-duplicate signatures and plan-level stalls (different units failing alike). [NOTES "Following a run"]
- Native sandbox: a SIGKILL of heph leaves the command's process group running until it ends; there is no record to find it by. Container mode labels and reaps containers. [NOTES "Resume and idempotency"]
- Coverage delta and a TS `defineGate` are not built; use custom command gates (recipes in NOTES, untested). [SPEC §11]

## Runs and nodes

- Remaining-budget tracking per provider and fallback on provider outages are not built (needs worker failure classes). [NOTES "Routing"]
- Cancel across processes without a daemon, Ctrl-C in `heph run`, and aborting a gate command on cancel are not built or not verified. [NOTES "Handoff wait"]
- An MCP call that times out (10 s, or 30 s for `heph_run`) may still have started the build; calling `heph_run` again answers `already_running`. [NOTES "MCP server: follow-ups"]
- The CLI's `heph watch` retries every daemon error and its daemon calls have no timeout, on purpose. [same]
- Stacking: a run always starts from its target; building on another run's branch needs the earlier one merged. [NOTES "Stacking"]

## Measurement

- `heph eval` has not run live against the private suite; the planner-gate before/after measurement is still owed. [progress.md, NOTES "Measuring the planner gates"]
- `heph stats` cannot see manual edits after a PR opens, or work done in direct sessions that never went through heph.

## Environment

- macOS with Colima only mounts `$HOME`, so container-mode worktrees must live under it. [NOTES "OMP worker in a sandbox"]
