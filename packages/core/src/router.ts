import { z } from "zod";
import type { Complexity, Task } from "./schemas/plan.ts";

/** Escalation ladder: the complexity tiers plus `top`, which only roles with a `top` route reach. */
export const Rung = z.enum(["trivial", "standard", "complex", "top"]);
export type Rung = z.infer<typeof Rung>;

export const RUNGS: readonly Rung[] = ["trivial", "standard", "complex", "top"];

export type RouteSignals = {
  files: number;
  lines: number;
  criteria: number;
  crossProject: boolean;
  planner: Complexity;
};

const PLANNER_VOTE: Record<Complexity, number> = { trivial: 0, standard: 1, complex: 3 };

/** Picks the start tier for a task from cheap signals; may go below the planner's rating. */
export function routeTier(
  task: Task,
  signals: RouteSignals,
  complexScopeGlobs = 5,
): { tier: Complexity; score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const add = (n: number, why: string) => {
    if (n === 0) return;
    score += n;
    reasons.push(why);
  };
  add(signals.files, `${signals.files} files`);
  add(Math.floor(signals.lines / 100), `${signals.lines} lines`);
  add(2 * signals.criteria, `${signals.criteria} criteria`);
  add(task.lane !== "contained" ? 3 : 0, `lane ${task.lane}`);
  add(signals.crossProject ? 3 : 0, "cross-project");
  add(PLANNER_VOTE[signals.planner], `planner ${signals.planner}`);
  add(task.kind === "docs" ? -2 : 0, "kind docs");
  score = Math.max(0, score);

  const trivialQualifier =
    task.lane === "contained" &&
    signals.files <= 2 &&
    signals.lines <= 150 &&
    signals.criteria <= 1 &&
    !signals.crossProject;
  let tier: Complexity =
    score >= 14 ? "complex" : score <= 4 && trivialQualifier ? "trivial" : "standard";

  // Floors. The trivial qualifier already keeps these off `trivial`; the reasons record
  // that the floor applies whatever the score.
  if (task.lane === "wide" || task.lane === "irreversible") {
    reasons.push(`lane ${task.lane} floors at standard`);
  }
  if (signals.crossProject) reasons.push("cross-project floors at standard");
  if (task.scope.length > complexScopeGlobs && tier !== "complex") {
    tier = "complex";
    reasons.push(`${task.scope.length} scope globs floors at complex`);
  }

  return { tier, score, reasons };
}
