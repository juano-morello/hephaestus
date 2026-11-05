export type LayoutNode = { id: string; x: number; y: number; layer: number };
export type LayoutEdge = { from: string; to: string };
export type Layout = { nodes: LayoutNode[]; edges: LayoutEdge[]; width: number; height: number };

export const NODE_W = 176;
export const NODE_H = 56;
const GAP_X = 56;
const GAP_Y = 20;
const PAD = 16;

/**
 * Longest-path layering, left to right. A unit sits one layer right of its deepest dependency;
 * nodes of a layer keep input order. Dependencies on unknown ids and on the unit itself are
 * ignored, and a dependency that would close a cycle (a back edge) is dropped, so this always
 * terminates and returns every unit.
 */
export function layoutGraph(units: { id: string; depends_on: string[] }[]): Layout {
  const byId = new Map(units.map((u) => [u.id, u]));
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const edges: LayoutEdge[] = [];

  const visit = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    visiting.add(id);
    let l = 0;
    const seen = new Set<string>();
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (dep === id || !byId.has(dep) || seen.has(dep)) continue;
      seen.add(dep);
      if (visiting.has(dep)) continue; // back edge: dropped
      l = Math.max(l, visit(dep) + 1);
      edges.push({ from: dep, to: id });
    }
    visiting.delete(id);
    layer.set(id, l);
    return l;
  };
  for (const u of units) visit(u.id);

  const rows = new Map<number, number>();
  const nodes: LayoutNode[] = [];
  const seenIds = new Set<string>();
  for (const u of units) {
    if (seenIds.has(u.id)) continue;
    seenIds.add(u.id);
    const l = layer.get(u.id) ?? 0;
    const row = rows.get(l) ?? 0;
    rows.set(l, row + 1);
    nodes.push({
      id: u.id,
      layer: l,
      x: PAD + l * (NODE_W + GAP_X),
      y: PAD + row * (NODE_H + GAP_Y),
    });
  }
  const layers = nodes.reduce((m, n) => Math.max(m, n.layer + 1), 0);
  const tallest = Math.max(0, ...rows.values());
  return {
    nodes,
    edges,
    width: layers === 0 ? 0 : PAD * 2 + layers * NODE_W + (layers - 1) * GAP_X,
    height: tallest === 0 ? 0 : PAD * 2 + tallest * NODE_H + (tallest - 1) * GAP_Y,
  };
}
