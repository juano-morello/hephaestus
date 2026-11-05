import { describe, expect, test } from "bun:test";
import { layoutGraph, NODE_H, NODE_W } from "../src/graph-layout.ts";

const u = (id: string, ...depends_on: string[]) => ({ id, depends_on });
const layerOf = (l: ReturnType<typeof layoutGraph>, id: string) =>
  l.nodes.find((n) => n.id === id)?.layer;

describe("layoutGraph", () => {
  test("a chain puts each unit one layer right of its dependency", () => {
    const l = layoutGraph([u("a"), u("b", "a"), u("c", "b")]);
    expect([layerOf(l, "a"), layerOf(l, "b"), layerOf(l, "c")]).toEqual([0, 1, 2]);
    const [a, b] = l.nodes;
    expect(b?.x).toBeGreaterThan((a?.x ?? 0) + NODE_W);
    expect(l.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
  });

  test("independent units share layer 0", () => {
    const l = layoutGraph([u("a"), u("b"), u("c")]);
    expect(l.nodes.map((n) => n.layer)).toEqual([0, 0, 0]);
    expect(l.edges).toEqual([]);
  });

  test("a diamond puts the join after both parents", () => {
    const l = layoutGraph([u("a"), u("b", "a"), u("c", "a"), u("d", "b", "c")]);
    expect(layerOf(l, "d")).toBe(2);
    expect(layerOf(l, "b")).toBe(1);
    expect(layerOf(l, "c")).toBe(1);
  });

  test("a dependency on an unknown id is ignored", () => {
    const l = layoutGraph([u("a", "ghost")]);
    expect(layerOf(l, "a")).toBe(0);
    expect(l.edges).toEqual([]);
  });

  test("a two-node cycle terminates and returns both nodes", () => {
    const l = layoutGraph([u("a", "b"), u("b", "a")]);
    expect(l.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(l.edges.length).toBe(1);
  });

  test("a self-dependency is ignored", () => {
    const l = layoutGraph([u("a", "a")]);
    expect(l.nodes.length).toBe(1);
    expect(l.edges).toEqual([]);
  });

  test("no two nodes overlap", () => {
    const units = [
      u("a"),
      u("b"),
      u("c"),
      u("d", "a", "b"),
      u("e", "a"),
      u("f", "d", "e"),
      u("g", "c"),
      u("h", "g", "f"),
      u("i"),
      u("j", "i"),
      u("k", "j", "h"),
      u("l", "k"),
    ];
    const l = layoutGraph(units);
    expect(l.nodes.length).toBe(12);
    for (const [i, p] of l.nodes.entries()) {
      for (const q of l.nodes.slice(i + 1)) {
        const apartX = Math.abs(p.x - q.x) >= NODE_W;
        const apartY = Math.abs(p.y - q.y) >= NODE_H;
        expect(apartX || apartY).toBe(true);
      }
      expect(p.x + NODE_W).toBeLessThanOrEqual(l.width);
      expect(p.y + NODE_H).toBeLessThanOrEqual(l.height);
    }
  });

  test("an empty plan lays out to nothing", () => {
    expect(layoutGraph([])).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });
});
