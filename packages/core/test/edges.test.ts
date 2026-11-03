import { describe, expect, test } from "bun:test";
import { deriveEdges, reachability, topoOrder } from "../src/graph/edges.ts";
import { task } from "./helpers.ts";

const ids = (ts: { id: string }[]) => ts.map((t) => t.id);

describe("deriveEdges", () => {
  test("creates an edge only where a task consumes what another produces", () => {
    const tasks = [
      task("T1", { produces: ["proto:LootMsg"] }),
      task("T2", { consumes: ["proto:LootMsg"] }),
      task("T3"),
    ];
    const { edges, unresolved, duplicateProducers } = deriveEdges(tasks);
    expect(edges).toEqual([{ from: "T1", to: "T2", artifact: "proto:LootMsg" }]);
    expect(unresolved).toEqual([]);
    expect(duplicateProducers).toEqual([]);
  });

  test("produces no edges for independent tasks", () => {
    expect(deriveEdges([task("T1"), task("T2")]).edges).toEqual([]);
  });

  test("reports consumes with no producer", () => {
    const { edges, unresolved } = deriveEdges([task("T1", { consumes: ["fn:StackItems"] })]);
    expect(edges).toEqual([]);
    expect(unresolved).toEqual([{ task: "T1", artifact: "fn:StackItems" }]);
  });

  test("reports an artifact produced by more than one task and keeps edges from each", () => {
    const tasks = [
      task("T1", { produces: ["fn:StackItems"] }),
      task("T2", { produces: ["fn:StackItems"] }),
      task("T3", { consumes: ["fn:StackItems"] }),
    ];
    const { edges, duplicateProducers } = deriveEdges(tasks);
    expect(duplicateProducers).toEqual([{ artifact: "fn:StackItems", tasks: ["T1", "T2"] }]);
    expect(edges).toEqual([
      { from: "T1", to: "T3", artifact: "fn:StackItems" },
      { from: "T2", to: "T3", artifact: "fn:StackItems" },
    ]);
  });

  test("keeps a self-consumption as a self edge so it surfaces as a cycle", () => {
    const { edges } = deriveEdges([task("T1", { produces: ["fn:X"], consumes: ["fn:X"] })]);
    expect(edges).toEqual([{ from: "T1", to: "T1", artifact: "fn:X" }]);
  });
});

describe("topoOrder", () => {
  test("orders producers before consumers", () => {
    const tasks = [
      task("impl", { consumes: ["test:Cap", "fn:Helper"] }),
      task("test", { produces: ["test:Cap"] }),
      task("helper", { produces: ["fn:Helper"] }),
    ];
    const result = topoOrder(ids(tasks), deriveEdges(tasks).edges);
    expect(result).toEqual({ ok: true, order: ["test", "helper", "impl"] });
  });

  test("breaks ties by plan order", () => {
    const result = topoOrder(["B", "A", "C"], []);
    expect(result).toEqual({ ok: true, order: ["B", "A", "C"] });
  });

  test("reports a cycle as a closed path", () => {
    const tasks = [
      task("T1", { produces: ["fn:A"], consumes: ["fn:C"] }),
      task("T2", { produces: ["fn:B"], consumes: ["fn:A"] }),
      task("T3", { produces: ["fn:C"], consumes: ["fn:B"] }),
      task("T4"),
    ];
    const result = topoOrder(ids(tasks), deriveEdges(tasks).edges);
    expect(result).toEqual({ ok: false, cycle: ["T1", "T2", "T3", "T1"] });
  });

  test("reports a self edge as a cycle", () => {
    const result = topoOrder(["T1"], [{ from: "T1", to: "T1", artifact: "fn:X" }]);
    expect(result).toEqual({ ok: false, cycle: ["T1", "T1"] });
  });
});

describe("reachability", () => {
  test("returns transitive descendants of each task", () => {
    const tasks = [
      task("T1", { produces: ["a"] }),
      task("T2", { consumes: ["a"], produces: ["b"] }),
      task("T3", { consumes: ["b"] }),
      task("T4"),
    ];
    const reach = reachability(ids(tasks), deriveEdges(tasks).edges);
    expect([...(reach.get("T1") ?? [])].sort()).toEqual(["T2", "T3"]);
    expect([...(reach.get("T2") ?? [])]).toEqual(["T3"]);
    expect(reach.get("T3")?.size).toBe(0);
    expect(reach.get("T4")?.size).toBe(0);
  });
});
