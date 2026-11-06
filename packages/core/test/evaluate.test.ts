import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../src/gates/types.ts";
import { evaluatePlannerOutput, extractJson } from "../src/planner/evaluate.ts";
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

describe("extractJson errors", () => {
  test("say what is wrong instead of Unexpected EOF", () => {
    expect(() => extractJson("")).toThrow(/empty/);
    expect(() => extractJson("I would rather not.")).toThrow(/no JSON object/);
    expect(() => extractJson('{"schema":1,"tasks":[{"id":"T1"')).toThrow(/truncated/);
    expect(() => extractJson('```json\n{"schema":1,"tasks":[\n')).toThrow(/truncated/);
  });
  test("a fenced block with no closing fence still parses when complete", () => {
    expect(extractJson('```json\n{"a":1}\n')).toEqual({ a: 1 });
  });
});

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

  test("stamps brief_hash itself, so the planner need not output it", () => {
    const { brief_hash: _, ...withoutHash } = valid;
    const result = evaluatePlannerOutput(JSON.stringify(withoutHash), ctx, "stamped");
    expect(result).toMatchObject({ valid: true, failures: [] });
    expect(result.plan?.brief_hash).toBe("stamped");
  });

  test("overrides a brief_hash the planner made up", () => {
    const result = evaluatePlannerOutput(JSON.stringify(valid), ctx, "stamped");
    expect(result.valid).toBe(true);
    expect(result.plan?.brief_hash).toBe("stamped");
  });

  test("drops null-valued fields before parsing", () => {
    const withNulls = {
      ...valid,
      tasks: valid.tasks.map((t) => ({ ...t, context_budget: null, covers_note: null })),
    };
    const result = evaluatePlannerOutput(JSON.stringify(withNulls), ctx, "hash");
    expect(result).toMatchObject({ valid: true, failures: [] });
    expect(result.plan?.tasks[0]).not.toHaveProperty("context_budget");
  });

  test("still rejects a null where a value is required", () => {
    const broken = { ...valid, tasks: [{ ...valid.tasks[0], scope: [null] }] };
    expect(evaluatePlannerOutput(JSON.stringify(broken), ctx, "hash").failures).toEqual(["schema"]);
  });

  test("reports an escalation with its reasons, not as a failure", () => {
    const output = JSON.stringify({ schema: 1, escalate: ["AC2 cannot be checked"] });
    const result = evaluatePlannerOutput(output, ctx, "hash");
    expect(result).toMatchObject({ valid: false, failures: [], gates: [] });
    expect(result.escalate).toEqual(["AC2 cannot be checked"]);
    expect(result.plan).toBeUndefined();
  });

  test("buckets an escalation without reasons as schema", () => {
    const result = evaluatePlannerOutput('{"schema":1,"escalate":[]}', ctx, "hash");
    expect(result.failures).toEqual(["schema"]);
    expect(result.escalate).toBeUndefined();
  });

  test("buckets a plan that also escalates as schema", () => {
    const output = JSON.stringify({ ...valid, escalate: ["unsure"] });
    expect(evaluatePlannerOutput(output, ctx, "hash").failures).toEqual(["schema"]);
  });

  test("lists failed gates by name", () => {
    const broken = plan([task("T1", { covers: ["AC1"] })]);
    const result = evaluatePlannerOutput(JSON.stringify(broken), ctx, "hash");
    expect(result.failures).toEqual(["criteria_covered", "test_precedes_implement"]);
  });
});
