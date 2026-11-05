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
 * Within a project a test unit is a barrier at its place in canonical order, because every unit's
 * `tests` gate (and a join's re-gate) runs the project's whole suite: it starts only when every
 * unit of its project ordered before it is accepted and nothing else of the project is in flight,
 * and no unit of the project ordered after it starts until it is accepted. Non-test units between
 * two test units of a project run in parallel; units of different projects never hold each other
 * back this way. So each project sees its tests and implementations in the sequential order the
 * plan gate's `tests_passable` simulates, and with `free` 1 the order is exactly that order.
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
  const position = new Map(order.order.map((id, i) => [id, i]));
  const before = (a: string, b: string) => (position.get(a) ?? 0) < (position.get(b) ?? 0);
  const isTest = (id: string) => byId.get(id)?.kind === "test";
  const open = plan.tasks.filter((u) => !state.accepted.has(u.id)).map((u) => u.id);

  for (const id of order.order) {
    if (picked.length >= free) break;
    const t = byId.get(id);
    if (!t || state.accepted.has(id) || state.inFlight.has(id)) continue;
    if (!edges.filter((e) => e.to === id).every((e) => state.accepted.has(e.from))) continue;
    if (!testsPassableAfter(plan.tasks, state.accepted, t)) continue;
    const ours = (other: string) => other !== id && projectOf(other) === t.project;
    const busy = [...running, ...picked].filter(ours);
    const unfinished = open.filter(ours);
    if (t.kind === "test") {
      if (busy.length > 0 || unfinished.some((other) => before(other, id))) continue;
    } else if (busy.some(isTest) || unfinished.some((other) => isTest(other) && before(other, id)))
      continue;
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
