import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../src/gates/types.ts";
import { evaluatePlannerOutput, extractJson } from "../src/planner/evaluate.ts";
import { brief, plan, task, workspace } from "./helpers.ts";

const ctx = { brief: brief(), workspace: workspace(), limits: DEFAULT_LIMITS };
const valid = plan([
  task("T1", { kind: "test", covers: ["AC1"], scope: ["a_test.go"], produces: ["test:A"] }),
  task("T2", { covers: ["AC1"], scope: ["a.go"], consumes: ["test:A"] }),
]);

describe("extractJson", () => {
  test("reads bare, fenced and prose-wrapped JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a":1} done')).toEqual({ a: 1 });
  });
});

describe("evaluatePlannerOutput", () => {
  test("accepts a plan that passes every gate", () => {
    const result = evaluatePlannerOutput(JSON.stringify(valid), ctx, "hash");
    expect(result).toMatchObject({ valid: true, failures: [] });
  });

  test("buckets unparseable output as json_parse", () => {
    const result = evaluatePlannerOutput("I cannot plan this.", ctx, "hash");
    expect(result).toMatchObject({ valid: false, failures: ["json_parse"], gates: [] });
  });

  test("buckets schema violations with the offending path", () => {
    const result = evaluatePlannerOutput(JSON.stringify({ ...valid, schema: 2 }), ctx, "hash");
    expect(result.failures).toEqual(["schema"]);
    expect(result.error).toContain("schema:");
  });

  test("flags a wrong brief_hash and still runs the gates", () => {
    const result = evaluatePlannerOutput(JSON.stringify(valid), ctx, "other");
    expect(result.failures).toEqual(["brief_hash"]);
    expect(result.gates).toHaveLength(8);
  });

  test("lists failed gates by name", () => {
    const broken = plan([task("T1", { covers: ["AC1"] })]);
    const result = evaluatePlannerOutput(JSON.stringify(broken), ctx, "hash");
    expect(result.failures).toEqual(["criteria_covered", "test_precedes_implement"]);
  });
});
