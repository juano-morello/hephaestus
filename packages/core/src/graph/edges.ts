import type { Task } from "../schemas/plan.ts";

export type Edge = { from: string; to: string; artifact: string };

export type DerivedEdges = {
  edges: Edge[];
  unresolved: { task: string; artifact: string }[];
  duplicateProducers: { artifact: string; tasks: string[] }[];
};

export type TopoResult = { ok: true; order: string[] } | { ok: false; cycle: string[] };

/** Edges are never declared: one exists only where a task consumes what another produces. */
export function deriveEdges(tasks: readonly Task[]): DerivedEdges {
  const producers = new Map<string, string[]>();
  for (const t of tasks) {
    for (const artifact of t.produces ?? []) {
      const list = producers.get(artifact) ?? [];
      list.push(t.id);
      producers.set(artifact, list);
    }
  }

  const edges: Edge[] = [];
  const unresolved: DerivedEdges["unresolved"] = [];
  for (const t of tasks) {
    for (const artifact of t.consumes ?? []) {
      const from = producers.get(artifact);
      if (!from) {
        unresolved.push({ task: t.id, artifact });
        continue;
      }
      for (const producer of from) edges.push({ from: producer, to: t.id, artifact });
    }
  }

  const duplicateProducers = [...producers]
    .filter(([, ids]) => ids.length > 1)
    .map(([artifact, ids]) => ({ artifact, tasks: ids }));

  return { edges, unresolved, duplicateProducers };
}

function successors(ids: readonly string[], edges: readonly Edge[]): Map<string, string[]> {
  const next = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    const list = next.get(e.from);
    if (list && !list.includes(e.to)) list.push(e.to);
  }
  return next;
}

/** Kahn's algorithm; ready nodes are taken in plan order so the result is deterministic. */
export function topoOrder(ids: readonly string[], edges: readonly Edge[]): TopoResult {
  const next = successors(ids, edges);
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const targets of next.values()) {
    for (const to of targets) indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }

  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < ids.length) {
    const ready = ids.find((id) => !done.has(id) && indegree.get(id) === 0);
    if (ready === undefined) return { ok: false, cycle: findCycle(ids, next, done) };
    order.push(ready);
    done.add(ready);
    for (const to of next.get(ready) ?? []) indegree.set(to, (indegree.get(to) ?? 0) - 1);
  }
  return { ok: true, order };
}

function findCycle(
  ids: readonly string[],
  next: Map<string, string[]>,
  done: Set<string>,
): string[] {
  const onPath = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (id: string): string[] | undefined => {
    if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id) || done.has(id)) return undefined;
    visited.add(id);
    onPath.add(id);
    path.push(id);
    for (const to of next.get(id) ?? []) {
      const cycle = visit(to);
      if (cycle) return cycle;
    }
    onPath.delete(id);
    path.pop();
    return undefined;
  };

  for (const id of ids) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return [];
}

/** Transitive descendants of every task. */
export function reachability(
  ids: readonly string[],
  edges: readonly Edge[],
): Map<string, Set<string>> {
  const next = successors(ids, edges);
  const reach = new Map<string, Set<string>>();
  for (const start of ids) {
    const seen = new Set<string>();
    const stack = [...(next.get(start) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(next.get(id) ?? []));
    }
    reach.set(start, seen);
  }
  return reach;
}
