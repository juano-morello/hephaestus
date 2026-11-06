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
  /** Aborted to stop the attempt (handoff, cancel): the worker stops and exits "interrupted". */
  signal?: AbortSignal;
  /** Wall-clock limit for the attempt; the worker aborts itself and reports a "timeout" failure. */
  timeoutMs?: number;
  /** Abort after this long with no model output and no tool running ("idle" failure). */
  idleTimeoutMs?: number;
};

/** Why a worker ended without a result: `kind` is short and stable, `detail` is for people. */
export type WorkerFailure = { kind: "timeout" | "idle" | "error" | (string & {}); detail: string };

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
  /** With exit "error": what went wrong, when the worker knows (a hang, a timeout, a thrown error). */
  failure?: WorkerFailure;
  /** With rate_limited: when the provider says to try again (ISO 8601), if it says. */
  retry_after?: string;
};

export type Worker = { spawn(input: SpawnInput): Promise<SpawnOutput> };
