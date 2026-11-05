import { describe, expect, test } from "bun:test";
import { readyUnits, type SchedState } from "../src/graph/ready.ts";
import { plan, task, workspace } from "./helpers.ts";

const state = (over: Partial<SchedState> = {}): SchedState => ({
  accepted: new Set(),
  inFlight: new Set(),
  scopeOf: () => [],
  ...over,
});

describe("readyUnits", () => {
  test("readyUnits_respects_edges", () => {
    const p = plan([task("T1", { produces: ["a"] }), task("T2", { consumes: ["a"] })]);
    expect(readyUnits(p, workspace(), state(), 5)).toEqual(["T1"]);
    expect(readyUnits(p, workspace(), state({ accepted: new Set(["T1"]) }), 5)).toEqual(["T2"]);
  });

  test("readyUnits_caps_at_free", () => {
    const p = plan([task("T1"), task("T2"), task("T3")]);
    expect(readyUnits(p, workspace(), state(), 2)).toEqual(["T1", "T2"]);
  });

  test("readyUnits_waits_for_satisfier_of_accepted_test", () => {
    const p = plan([
      task("T1", { kind: "test", covers: ["AC1"] }),
      task("T2", { covers: ["AC1"] }),
      task("T3", { covers: ["AC2"] }),
    ]);
    expect(readyUnits(p, workspace(), state({ accepted: new Set(["T1"]) }), 5)).toEqual(["T2"]);
  });

  test("readyUnits_skips_overlapping_scope_with_in_flight", () => {
    const p = plan([task("T2"), task("T3")]);
    const run = (scope: string[]) =>
      readyUnits(
        p,
        workspace(),
        state({
          inFlight: new Set(["T2"]),
          scopeOf: (id) => (id === "T2" ? ["src/**"] : scope),
        }),
        5,
      );
    expect(run(["src/a.go"])).toEqual([]);
    expect(run(["docs/x.md"])).toEqual(["T3"]);
  });

  test("readyUnits_other_repo_never_overlaps", () => {
    const p = plan([task("T2", { project: "server" }), task("T3", { project: "client" })]);
    const s = state({ inFlight: new Set(["T2"]), scopeOf: () => ["src/**"] });
    expect(readyUnits(p, workspace(), s, 5)).toEqual(["T3"]);
  });
});
