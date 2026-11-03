import { expect, test } from "bun:test";
import { join } from "node:path";
import { runPlanGates } from "../src/gates/plan.ts";
import { DEFAULT_LIMITS } from "../src/gates/types.ts";
import { Plan } from "../src/schemas/plan.ts";
import { brief, gates, workspace } from "./helpers.ts";

// The worked example in the planner prompt must itself pass every gate.
test("planner prompt example is a valid plan", async () => {
  const text = await Bun.file(join(import.meta.dir, "..", "prompts", "planner.md")).text();
  const json = /## Example[\s\S]*?```json\n([\s\S]*?)\n```/.exec(text)?.[1];
  expect(json).toBeDefined();
  const plan = Plan.parse(JSON.parse(json as string));
  const b = brief({
    acceptance: [
      ...["AC1", "AC2", "AC3"].map((id) => ({ id, text: id, kind: "behavior" as const })),
      { id: "AC4", text: "buf passes", kind: "nonfunctional", check: { gate: "buf" } },
    ],
  });
  const ctx = { brief: b, workspace: workspace(), limits: DEFAULT_LIMITS, projectGates: gates() };
  const results = runPlanGates(plan, ctx);
  expect(results.filter((r) => r.verdict === "fail")).toEqual([]);
  expect(results.find((r) => r.gate === "complexity_sanity")?.evidence).toEqual([]);
});
