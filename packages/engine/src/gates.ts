import type { GateResult, Task, WorkerResult } from "@hephaestus/core";
import type { Diff } from "./git.ts";

export type UnitGateContext = {
  task: Task;
  attempt: number;
  project: string;
  /** Project root inside the repo, "." for the repo root. */
  projectPath: string;
  /** The project root inside the attempt's worktree. */
  workdir: string;
  /** Repo-relative files and full text of the attempt's commit against the run branch tip. */
  diff: Diff;
  /** Project-relative paths the attempt must not modify. */
  lockedPaths: string[];
  worker: WorkerResult;
};

/** A deterministic check on one attempt (SPEC section 11). Built-in gates arrive in v0 step 2.4. */
export type UnitGate = {
  name: string;
  run(ctx: UnitGateContext): GateResult | Promise<GateResult>;
};
