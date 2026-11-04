import type { UnitBrief } from "@hephaestus/core";
import type { Usage } from "@hephaestus/ledger";

/** SPEC section 3: spawn(role, brief, workdir, tools, model, effort). */
export type SpawnInput = {
  role: string;
  brief: UnitBrief;
  /** The project root inside the attempt's worktree. */
  workdir: string;
  tools: string[];
  model: string;
  effort?: string;
};

/**
 * The worker's diff is not part of its output: the engine reads the diff from git, because the
 * diff is the truth (SPEC section 8). `output` is checked against WorkerResult by the engine.
 */
export type SpawnOutput = {
  output: unknown;
  transcript: string;
  usage: Usage;
  exit: "ok" | "error" | "rate_limited" | "interrupted";
  prompt_hash?: string;
  /** With rate_limited: when the provider says to try again (ISO 8601), if it says. */
  retry_after?: string;
};

export type Worker = { spawn(input: SpawnInput): Promise<SpawnOutput> };
