import { expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_LIMITS, Plan, runPlanGates } from "@hephaestus/core";
import { brief, gates, workspace } from "./planner-fixtures.ts";

// The worked example in the planner prompt must itself pass every gate.
test("planner prompt example is a valid plan", async () => {
  const text = await Bun.file(join(import.meta.dir, "..", "prompts", "planner.md")).text();
  const json = /## Example[\s\S]*?```json\n([\s\S]*?)\n```/.exec(text)?.[1];
  expect(json).toBeDefined();
  // brief_hash is stamped by code, never written by the planner.
  const plan = Plan.parse({ ...JSON.parse(json as string), brief_hash: "stamped" });
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

test("planner prompt says a criterion with projects needs a test task in each project", async () => {
  const text = await Bun.file(join(import.meta.dir, "..", "prompts", "planner.md")).text();
  expect(text).toContain(
    "A criterion with `projects` needs a `test` task in each listed project that lists its id in `covers`.",
  );
});

test("planner prompt carries the self-consistency rules", async () => {
  const text = await Bun.file(join(import.meta.dir, "..", "prompts", "planner.md")).text();
  expect(text).toContain("Test assertions follow the dependency order");
  expect(text).toContain("Read the current repo state before assigning identifiers");
  expect(text).toContain("Blast radius of changed behavior");
  expect(text).toContain("golden");
  expect(text).toContain("Criteria about existing tooling need a check");
  expect(text).toContain("regression-check task");
});

test("planner prompt tells the planner to declare new files in creates", async () => {
  const text = await Bun.file(join(import.meta.dir, "..", "prompts", "planner.md")).text();
  expect(text).toContain("creates?: string[]");
  expect(text).toContain("scope paths that do not exist and are not in `creates` are rejected");
  // The worked example declares its one new file.
  const json = /## Example[\s\S]*?```json\n([\s\S]*?)\n```/.exec(text)?.[1] as string;
  expect(JSON.parse(json).tasks[3].creates).toEqual(["internal/ability/cooldown.go"]);
});
