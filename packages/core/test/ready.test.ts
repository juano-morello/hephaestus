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

  // Found live: two independent test->implement chains in one project, started together at
  // parallel=2, left two red tests that each blocked the other chain's implement unit.
  test("readyUnits_runs_two_test_chains_in_one_project_one_test_at_a_time", () => {
    const p = plan([
      task("T1", { kind: "test", covers: ["AC1"], produces: ["t1"] }),
      task("T2", { covers: ["AC1"], consumes: ["t1"] }),
      task("T3", { kind: "test", covers: ["AC2"], produces: ["t3"] }),
      task("T4", { covers: ["AC2"], consumes: ["t3"] }),
    ]);
    const accepted = new Set<string>();
    const steps: string[][] = [];
    for (let i = 0; i < 6 && accepted.size < 4; i++) {
      const ready = readyUnits(p, workspace(), state({ accepted }), 2);
      steps.push(ready);
      for (const id of ready) accepted.add(id);
    }
    expect(steps).toEqual([["T1"], ["T2"], ["T3"], ["T4"]]);
  });

  test("readyUnits_test_unit_waits_for_any_unit_of_its_project_in_flight", () => {
    const p = plan([task("T1"), task("T2", { kind: "test", covers: ["AC2"] })]);
    expect(readyUnits(p, workspace(), state({ inFlight: new Set(["T1"]) }), 2)).toEqual([]);
    // Picked in the same call counts as in flight.
    expect(readyUnits(p, workspace(), state(), 2)).toEqual(["T1"]);
  });

  test("readyUnits_non_test_unit_waits_for_a_test_unit_of_its_project_in_flight", () => {
    const p = plan([
      task("T1", { kind: "test", covers: ["AC1"] }),
      task("T2", { covers: ["AC2"] }),
    ]);
    expect(readyUnits(p, workspace(), state({ inFlight: new Set(["T1"]) }), 2)).toEqual([]);
    expect(readyUnits(p, workspace(), state(), 2)).toEqual(["T1"]);
  });

  test("readyUnits_test_unit_waits_for_open_criteria_of_its_project", () => {
    const p = plan([
      task("T1", { kind: "test", covers: ["AC1"] }),
      task("T2", { covers: ["AC1"] }),
      task("T3", { kind: "test", covers: ["AC2"] }),
    ]);
    expect(readyUnits(p, workspace(), state({ accepted: new Set(["T1"]) }), 2)).toEqual(["T2"]);
  });

  test("readyUnits_two_independent_implement_units_in_one_project_run_together", () => {
    const p = plan([task("T1"), task("T2")]);
    expect(readyUnits(p, workspace(), state(), 2)).toEqual(["T1", "T2"]);
  });

  test("readyUnits_test_chains_in_different_projects_run_together", () => {
    const p = plan([
      task("T1", { kind: "test", project: "server", covers: ["AC1"], produces: ["s"] }),
      task("T2", { project: "server", covers: ["AC1"], consumes: ["s"] }),
      task("T3", { kind: "test", project: "client", covers: ["AC2"], produces: ["c"] }),
      task("T4", { project: "client", covers: ["AC2"], consumes: ["c"] }),
    ]);
    expect(readyUnits(p, workspace(), state(), 2)).toEqual(["T1", "T3"]);
    expect(readyUnits(p, workspace(), state({ accepted: new Set(["T1", "T3"]) }), 2)).toEqual([
      "T2",
      "T4",
    ]);
    // A client test may start while a server unit is in flight, and the other way round.
    expect(
      readyUnits(
        p,
        workspace(),
        state({ accepted: new Set(["T1"]), inFlight: new Set(["T2"]) }),
        2,
      ),
    ).toEqual(["T3"]);
  });

  test("readyUnits_other_repo_never_overlaps", () => {
    const p = plan([task("T2", { project: "server" }), task("T3", { project: "client" })]);
    const s = state({ inFlight: new Set(["T2"]), scopeOf: () => ["src/**"] });
    expect(readyUnits(p, workspace(), s, 5)).toEqual(["T3"]);
  });
});
