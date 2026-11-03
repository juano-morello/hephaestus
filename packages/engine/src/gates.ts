import type { ContextPack, GateResult, Task, WorkerResult } from "@hephaestus/core";
import type { Sandbox } from "@hephaestus/sandbox";
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
  /** The project's test, typecheck and lint commands. */
  commands: ContextPack["project"]["commands"];
  timeoutMs: number;
  /** A fresh sandbox over the attempt's project dir, opened when a gate needs one. */
  sandbox?: Sandbox;
};

/** A deterministic check on one attempt (SPEC section 11). */
export type UnitGate = {
  name: string;
  /** The engine opens a sandbox for this attempt's gates when any gate sets this. */
  needsSandbox?: true;
  run(ctx: UnitGateContext): GateResult | Promise<GateResult>;
};
