import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkEvalTask } from "../src/eval/check.ts";
import { loadSuite } from "../src/eval/suite.ts";
import { EvalTask } from "../src/schemas/eval.ts";
import { brief, gates, workspace } from "./helpers.ts";

const task = (overrides: Partial<EvalTask> = {}): EvalTask => ({
  id: "stacking-cap",
  workspace_ref: { server: "a1b2c3d" },
  brief: "../briefs/stacking-cap.yaml",
  oracle: {
    hidden_tests: [
      { project: "server", from: "./oracle/cap_test.go", to: "internal/inventory/cap_test.go" },
    ],
    must_pass: [{ project: "server", run: "go test ./internal/inventory/..." }],
    must_not_touch: [{ project: "server", paths: ["internal/persistence/**"] }],
  },
  tags: ["server", "contained", "small"],
  ...overrides,
});

const escalating = (): EvalTask => {
  const { oracle: _, ...rest } = task({ id: "contradiction" });
  return { ...rest, expect: "escalate" };
};

const ctx = (overrides: Partial<Parameters<typeof checkEvalTask>[1]> = {}) => ({
  workspace: workspace(),
  projectGates: gates(),
  brief: brief({ known_paths: [{ project: "server", paths: ["internal/inventory/"] }] }),
  hiddenTestExists: () => true,
  ...overrides,
});

describe("EvalTask schema", () => {
  test("accepts a task with an oracle", () => {
    expect(EvalTask.safeParse(task()).success).toBe(true);
  });

  test("accepts a should-escalate task", () => {
    expect(EvalTask.safeParse(escalating()).success).toBe(true);
  });

  test("rejects a task with both oracle and expect, or neither", () => {
    const both = EvalTask.safeParse({ ...task(), expect: "escalate" });
    expect(both.success).toBe(false);
    expect(both.error?.issues[0]?.message).toBe("set exactly one of oracle or expect");
    const { oracle: _, ...neither } = task();
    expect(EvalTask.safeParse(neither).success).toBe(false);
  });

  test("rejects a hidden test destination outside the project", () => {
    for (const to of ["/etc/passwd", "../other/x_test.go"]) {
      const t = task();
      const ht = t.oracle?.hidden_tests[0];
      if (ht) ht.to = to;
      expect(EvalTask.safeParse(t).success).toBe(false);
    }
  });

  test("rejects a pinned ref that is not a commit sha", () => {
    expect(EvalTask.safeParse(task({ workspace_ref: { server: "main" } })).success).toBe(false);
  });

  test("defaults must_not_touch to empty", () => {
    const t = task();
    const { must_not_touch: _, ...oracle } = t.oracle as NonNullable<EvalTask["oracle"]>;
    const parsed = EvalTask.parse({ ...t, oracle });
    expect(parsed.oracle?.must_not_touch).toEqual([]);
  });
});

describe("checkEvalTask", () => {
  test("a complete task is ready", () => {
    expect(checkEvalTask(task(), ctx())).toEqual({
      id: "stacking-cap",
      status: "ready",
      issues: [],
    });
  });

  test("a should-escalate task needs no oracle files", () => {
    const result = checkEvalTask(escalating(), ctx({ hiddenTestExists: () => false }));
    expect(result.status).toBe("ready");
  });

  test("a missing hidden test means the user still owes the oracle", () => {
    const result = checkEvalTask(task(), ctx({ hiddenTestExists: () => false }));
    expect(result).toEqual({
      id: "stacking-cap",
      status: "needs_oracle",
      issues: ["oracle: hidden test ./oracle/cap_test.go is missing"],
    });
  });

  test("an unloadable brief is invalid", () => {
    const result = checkEvalTask(task(), ctx({ brief: undefined, briefError: "file not found" }));
    expect(result).toMatchObject({ status: "invalid", issues: ["brief: file not found"] });
  });

  test("a brief that fails the brief gate is invalid", () => {
    const result = checkEvalTask(task(), ctx({ brief: brief({ open_questions: ["why?"] }) }));
    expect(result).toMatchObject({
      status: "invalid",
      issues: ["brief gate: open question: why?"],
    });
  });

  test("pins must name workspace repos", () => {
    const result = checkEvalTask(
      task({ workspace_ref: { server: "a1b2c3d", mobile: "abcdef0" } }),
      ctx(),
    );
    expect(result.issues).toEqual(['workspace_ref: repo "mobile" is not in the workspace']);
  });

  test("every repo the task touches must be pinned", () => {
    const b = brief({ known_paths: [{ project: "client", paths: ["scripts/net/"] }] });
    const result = checkEvalTask(task(), ctx({ brief: b }));
    expect(result).toMatchObject({
      status: "invalid",
      issues: ['workspace_ref: repo "client" (project client) is not pinned'],
    });
  });

  test("oracle entries must name workspace projects", () => {
    const t = task();
    t.oracle?.must_pass.push({ project: "mobile", run: "make test" });
    expect(checkEvalTask(t, ctx()).issues).toEqual([
      'oracle: project "mobile" is not in the workspace',
    ]);
  });

  test("two hidden tests cannot land on the same file", () => {
    const t = task();
    const first = t.oracle?.hidden_tests[0];
    if (first) t.oracle?.hidden_tests.push({ ...first, from: "./oracle/other_test.go" });
    expect(checkEvalTask(t, ctx()).issues).toEqual([
      "oracle: two hidden tests land on server:internal/inventory/cap_test.go",
    ]);
  });
});

describe("loadSuite", () => {
  test("loads the synthetic fixture suite and reports readiness per task", async () => {
    const suite = await loadSuite(join(import.meta.dir, "..", "fixtures"));
    expect(suite.tasks.map((t) => t.check)).toEqual([
      {
        id: "loot-drop-client",
        status: "needs_oracle",
        issues: ["oracle: hidden test ./oracle/loot-drop-client/test_loot_marker.gd is missing"],
      },
      { id: "stacking-cap", status: "ready", issues: [] },
    ]);
  });

  test("reports a task file that fails the schema as invalid", async () => {
    const dir = join(import.meta.dir, "..", "fixtures");
    const suite = await loadSuite(dir, { evalsDir: join(import.meta.dir, "eval-fixtures") });
    expect(suite.tasks).toHaveLength(1);
    expect(suite.tasks[0]?.check.status).toBe("invalid");
    expect(suite.tasks[0]?.check.issues[0]).toStartWith("schema: ");
  });
});
