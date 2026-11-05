import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../src/gates/types.ts";
import { evaluatePlannerOutput } from "../src/planner/evaluate.ts";
import { FAULTS } from "../src/planner/faults.ts";
import { brief, gates, plan, task, workspace } from "./helpers.ts";

const ctx = {
  brief: brief(),
  workspace: workspace(),
  limits: DEFAULT_LIMITS,
  projectGates: gates(),
};
const valid = plan([
  task("T1", { kind: "test", covers: ["AC1"], scope: ["a_test.go"], produces: ["test:A"] }),
  task("T2", { covers: ["AC1"], scope: ["a.go"], consumes: ["test:A"] }),
]);

describe("seeded faults", () => {
  test("the base plan is valid", () => {
    expect(evaluatePlannerOutput(JSON.stringify(valid), ctx, "hash").valid).toBe(true);
  });

  for (const fault of FAULTS) {
    test(`${fault.name} fails ${fault.expect}`, () => {
      const ev = evaluatePlannerOutput(fault.apply(valid), ctx, "hash");
      expect(ev.valid).toBe(false);
      expect(ev.failures).toContain(fault.expect);
    });
  }
});
