import {
  type Complexity,
  DEFAULT_LIMITS,
  deriveEdges,
  globsOverlap,
  type Plan,
  type RouteSignals,
  routeTier,
  type Task,
} from "@hephaestus/core";
import type { Git } from "./git.ts";
import { projectRelative } from "./paths.ts";

/** Above this many matched files, lines are estimated (100 per file) instead of read. */
const MAX_LINE_READS = 20;

export type RouteInput = {
  git: Git;
  /** Where the task's files are read: the run branch tip when the unit starts. */
  ref: string;
  projectPath: string;
  task: Task;
  plan: Plan;
};

/** What `unit.attempt.started` records as `routed` on a unit's first attempt. */
export type Routed = {
  tier: Complexity;
  score: number;
  planner_tier: Complexity;
  reasons: string[];
};

/** The router's signals for a task, from its project's files at `ref` and the plan. */
export async function routeSignals(o: RouteInput): Promise<RouteSignals> {
  const { task: t } = o;
  const matched = (await o.git.lsTree(o.ref)).filter((f) => {
    const rel = projectRelative(o.projectPath, f);
    return rel !== undefined && t.scope.some((g) => globsOverlap(g, rel));
  });
  let lines = matched.length * 100;
  if (matched.length <= MAX_LINE_READS) {
    lines = 0;
    // A measurement never stops routing: a file whose lines can't be read counts as 0.
    for (const f of matched) lines += await o.git.fileLines(o.ref, f).catch(() => 0);
  }
  // As complexitySanity computes it: some input of the task comes from another project.
  const projectOf = new Map(o.plan.tasks.map((x) => [x.id, x.project]));
  const crossProject = deriveEdges(o.plan.tasks).edges.some(
    (e) => e.to === t.id && projectOf.get(e.from) !== t.project,
  );
  return {
    files: matched.length,
    lines,
    criteria: t.covers.length,
    crossProject,
    planner: t.complexity,
  };
}

/** The unit's start tier (routing design 1), with what the ledger records about it. */
export async function routeUnit(o: RouteInput): Promise<Routed> {
  const { tier, score, reasons } = routeTier(
    o.task,
    await routeSignals(o),
    DEFAULT_LIMITS.complexScopeGlobs,
  );
  return { tier, score, planner_tier: o.task.complexity, reasons };
}
