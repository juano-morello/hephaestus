import { scopesOverlap, testsPassableAfter } from "../gates/plan.ts";
import type { Plan } from "../schemas/plan.ts";
import type { Workspace } from "../schemas/workspace.ts";
import { deriveEdges, topoOrder } from "./edges.ts";

export type SchedState = {
  accepted: ReadonlySet<string>;
  inFlight: ReadonlySet<string>;
  /** Scope globs a unit is (or would be) allowed to touch, repo-relative to its project. */
  scopeOf: (id: string) => string[];
};

/**
 * Units that may start now: every dependency accepted, tests still passable, and no scope overlap
 * with a unit in the same repo that is in flight (or was just picked). At most `free`, in
 * canonical order (topological, plan order on ties).
 *
 * Within a project a test unit is exclusive, because every unit's `tests` gate (and a join's
 * re-gate) runs the project's whole suite: a test unit starts only when nothing else of its project
 * is in flight and the project has no open criterion (one an accepted test checks that no accepted
 * work covers yet, but remaining work does), and nothing else of the project starts while it runs.
 * Units of different projects never hold each other back this way.
 */
export function readyUnits(
  plan: Plan,
  workspace: Workspace,
  state: SchedState,
  free: number,
): string[] {
  const { edges } = deriveEdges(plan.tasks);
  const order = topoOrder(
    plan.tasks.map((t) => t.id),
    edges,
  );
  if (!order.ok) return [];
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const repoOf = (id: string) => {
    const t = byId.get(id);
    const p = t ? workspace.projects[t.project] : undefined;
    return { repo: p?.repo ?? `project:${t?.project}`, root: p?.path ?? "" };
  };
  const running = [...state.inFlight];
  const picked: string[] = [];
  const projectOf = (id: string) => byId.get(id)?.project;
  const impl = plan.tasks.filter((t) => t.kind !== "test");
  const covered = new Set(impl.filter((t) => state.accepted.has(t.id)).flatMap((t) => t.covers));
  const remaining = impl.filter((t) => !state.accepted.has(t.id));
  /** Projects with an accepted test that checks a criterion only remaining work covers. */
  const openProjects = new Set(
    plan.tasks
      .filter((t) => t.kind === "test" && state.accepted.has(t.id))
      .filter((t) =>
        t.covers.some((c) => !covered.has(c) && remaining.some((u) => u.covers.includes(c))),
      )
      .map((t) => t.project),
  );

  for (const id of order.order) {
    if (picked.length >= free) break;
    const t = byId.get(id);
    if (!t || state.accepted.has(id) || state.inFlight.has(id)) continue;
    if (!edges.filter((e) => e.to === id).every((e) => state.accepted.has(e.from))) continue;
    if (!testsPassableAfter(plan.tasks, state.accepted, t)) continue;
    const mine = [...running, ...picked].filter((other) => projectOf(other) === t.project);
    if (t.kind === "test" && (mine.length > 0 || openProjects.has(t.project))) continue;
    if (t.kind !== "test" && mine.some((other) => byId.get(other)?.kind === "test")) continue;
    const me = repoOf(id);
    const clash = [...running, ...picked].some((other) => {
      const o = repoOf(other);
      return (
        o.repo === me.repo &&
        scopesOverlap(state.scopeOf(id), state.scopeOf(other), me.root, o.root)
      );
    });
    if (clash) continue;
    picked.push(id);
  }
  return picked;
}
