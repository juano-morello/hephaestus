# Hephaestus

Hephaestus is a code-controlled agent harness for software engineering: code owns the control flow, and every LLM call is a typed function whose output is checked by deterministic gates.
A planner splits a Brief into small, scoped tasks, workers (OMP first) execute one task each in a sandbox, and the engine decides retries, merges and escalations from gate results alone.
It supports single-repo, monorepo and multi-repo workspaces, and the full design lives in [docs/SPEC.md](docs/SPEC.md).
