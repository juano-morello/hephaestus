import type { Brief } from "../schemas/brief.ts";
import type { ProjectGates } from "../schemas/gates.ts";
import type { Workspace } from "../schemas/workspace.ts";

export type Verdict = "pass" | "fail";

export type GateResult = {
  gate: string;
  verdict: Verdict;
  reason: string;
  evidence: string[];
};

export type PlanLimits = {
  /** More tasks than this means the brief is too big: replan or split it. */
  maxTasks: number;
  /** More scope globs than this on one task fails the plan. */
  maxScopeGlobs: number;
  /** More scope globs than this bumps a task to complex. */
  complexScopeGlobs: number;
};

export const DEFAULT_LIMITS: PlanLimits = {
  maxTasks: 12,
  maxScopeGlobs: 8,
  complexScopeGlobs: 5,
};

export type GateContext = {
  brief: Brief;
  workspace: Workspace;
  limits: PlanLimits;
  projectGates: ProjectGates;
};

export function result(gate: string, evidence: string[], passReason: string, failReason: string) {
  const failed = evidence.length > 0;
  return {
    gate,
    verdict: failed ? "fail" : "pass",
    reason: failed ? failReason : passReason,
    evidence,
  } satisfies GateResult;
}
