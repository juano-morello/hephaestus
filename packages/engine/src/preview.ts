import {
  type Complexity,
  type Criterion,
  DEFAULT_LIMITS,
  deriveEdges,
  type Lane,
  type Plan,
  type RouteSignals,
  reachability,
  readyUnits,
  routeTier,
  type Task,
  type TaskKind,
  topoOrder,
  type Workspace,
} from "@hephaestus/core";
import { builtinGates } from "./builtin-gates.ts";
import {
  type EngineConfig,
  fallbackRoute,
  ROLE_BY_KIND,
  type Route,
  resolveRoute,
} from "./config.ts";
import { customGatesFor } from "./custom-gates.ts";

export type PreviewUnit = {
  id: string;
  project: string;
  kind: TaskKind;
  lane: Lane;
  planner_tier: Complexity;
  start_tier: Complexity;
  score: number;
  reasons: string[];
  role: string;
  route: Route;
  top?: Route;
  fallback?: Route;
  attempt_timeout_ms?: number;
  /** Test units of the same project whose files this unit is built after and locked against. */
  locked_by: string[];
  gates: string[];
};

export type PreviewPrompt = { role: string; path: string; layer: "home" | "repo" | "workspace" };

export type Preview = {
  dry_run: true;
  run_id: string;
  parallel: number;
  /** Groups of units that could run together at `parallel`, assuming every unit is accepted. */
  waves: string[][];
  units: PreviewUnit[];
  prompts: PreviewPrompt[];
};

/**
 * What a build of `plan` would do, without doing any of it (SPEC section 5, `--dry-run`). Pure:
 * the router's signals come from the caller, which reads them from the target branch.
 */
export async function previewRun(o: {
  runId: string;
  plan: Plan;
  workspace: Workspace;
  config: EngineConfig;
  /** The Brief's acceptance criteria: a criterion naming a gate selects it for covering units. */
  criteria: Criterion[];
  signals: (task: Task) => Promise<RouteSignals>;
  prompts?: PreviewPrompt[];
}): Promise<Preview> {
  const { plan, workspace, config } = o;
  const ids = plan.tasks.map((t) => t.id);
  const { edges } = deriveEdges(plan.tasks);
  const sorted = topoOrder(ids, edges);
  const order = sorted.ok ? sorted.order : ids;
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const reach = reachability(ids, edges);

  const units: PreviewUnit[] = [];
  for (const id of order) {
    const task = byId.get(id) as Task;
    const { tier, score, reasons } = routeTier(
      task,
      await o.signals(task),
      DEFAULT_LIMITS.complexScopeGlobs,
    );
    const role = ROLE_BY_KIND[task.kind];
    const top = config.routing[role]?.top;
    const fallback = fallbackRoute(config, role);
    const timeout = config.attemptTimeoutByTier?.[tier] ?? config.attemptTimeoutMs;
    units.push({
      id,
      project: task.project,
      kind: task.kind,
      lane: task.lane,
      planner_tier: task.complexity,
      start_tier: tier,
      score,
      reasons,
      role,
      route: resolveRoute(config, role, tier),
      ...(top ? { top } : {}),
      ...(fallback ? { fallback } : {}),
      ...(timeout !== undefined ? { attempt_timeout_ms: timeout } : {}),
      locked_by: plan.tasks
        .filter((t) => t.kind === "test" && t.project === task.project && t.id !== id)
        .filter((t) => reach.get(t.id)?.has(id))
        .map((t) => t.id),
      gates: [
        ...builtinGates().map((g) => g.name),
        ...customGatesFor({ task, criteria: o.criteria, specs: config.customGates }).map(
          (g) => g.name,
        ),
      ],
    });
  }

  const waves: string[][] = [];
  const accepted = new Set<string>();
  const scopeOf = (id: string) => byId.get(id)?.scope ?? [];
  for (;;) {
    const wave = readyUnits(
      plan,
      workspace,
      { accepted, inFlight: new Set(), scopeOf },
      config.parallel,
    );
    if (!wave.length) break;
    waves.push(wave);
    for (const id of wave) accepted.add(id);
  }

  return {
    dry_run: true,
    run_id: o.runId,
    parallel: config.parallel,
    waves,
    units,
    prompts: o.prompts ?? [],
  };
}
