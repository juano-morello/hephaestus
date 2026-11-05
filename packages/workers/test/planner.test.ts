import { describe, expect, test } from "bun:test";
import { briefHash, type GateResult, type Plan } from "@hephaestus/core";
import {
  type PlannerSession,
  renderPlannerPrompt,
  repoMapFromFiles,
  runPlanner,
} from "../src/planner.ts";
import { brief, gates, workspace } from "./planner-fixtures.ts";

const task = {
  id: "T1",
  title: "tests",
  kind: "test",
  project: "server",
  lane: "contained",
  complexity: "standard",
  complexity_reason: "cases",
  scope: ["inventory/*_test.go"],
  covers: ["AC1"],
  produces: ["test:Cap"],
  spec: "write tests",
} as const;
const planJson = JSON.stringify({ schema: 1, tasks: [task], risks: [] });

/** A planner session that answers with `text` and records what it was asked. */
function fake(text: string) {
  const seen: { opts?: Record<string, unknown>; prompt?: string } = {};
  const session: PlannerSession = {
    async prompt(p) {
      seen.prompt = p;
      return true;
    },
    async abort() {},
    getLastAssistantMessage: () => ({ stopReason: "stop", content: [{ type: "text", text }] }),
    getSessionStats: () => ({ tokens: { input: 5, output: 7, cacheRead: 11, cacheWrite: 13 } }),
    messages: [{ role: "assistant" }],
    async dispose() {},
  };
  const createSession = async (opts: unknown) => {
    seen.opts = opts as Record<string, unknown>;
    return { session };
  };
  return { createSession, seen };
}

const input = (text: string, extra = {}) => ({
  brief: brief(),
  workspace: workspace(),
  projectGates: gates(),
  repoMap: "## server\ninventory/stack.go",
  route: { model: "claude/opus", effort: "high" },
  ...fake(text),
  ...extra,
});

describe("runPlanner", () => {
  test("a valid plan comes back stamped with the brief hash, with usage", async () => {
    const i = input(planJson);
    const r = await runPlanner(i);
    expect(r.evaluation.plan?.brief_hash).toBe(briefHash(brief()));
    expect(r.evaluation.plan?.tasks.map((t) => t.id)).toEqual(["T1"]);
    expect(r.usage).toEqual({ input: 5, output: 7, cache_read: 11, cache_write: 13 });
    expect(r.output).toBe(planJson);
    expect(r.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the planner gets no tools and nothing discovered", async () => {
    const i = input(planJson);
    await runPlanner(i);
    expect(i.seen.opts).toMatchObject({
      toolNames: [],
      enableMCP: false,
      enableLsp: false,
      disableExtensionDiscovery: true,
      modelPattern: "opus",
      skills: [],
      contextFiles: [],
    });
    expect(i.seen.opts?.customTools).toEqual([]);
  });

  test("an escalation and invalid output are reported as such", async () => {
    const esc = await runPlanner(
      input(JSON.stringify({ schema: 1, escalate: ["AC1 is not checkable"] })),
    );
    expect(esc.evaluation.escalate).toEqual(["AC1 is not checkable"]);
    const bad = await runPlanner(input("I would rather not."));
    expect(bad.evaluation).toMatchObject({ valid: false, failures: ["json_parse"] });
  });

  test("the file list reaches the plan gates", async () => {
    const r = await runPlanner(
      input(
        JSON.stringify({
          schema: 1,
          tasks: [{ ...task, scope: ["nowhere/*_test.go"] }],
          risks: [],
        }),
        {
          files: { server: ["inventory/stack.go"] },
        },
      ),
    );
    expect(r.evaluation.failures).toContain("scope_paths");
  });
});

describe("renderPlannerPrompt", () => {
  const template =
    "B {{brief}} W {{workspace}} G {{project_gates}} M {{repo_maps}}\n{{revision}}\n{{feedback}}";

  test("fills every slot and leaves revision and feedback empty when unused", () => {
    const text = renderPlannerPrompt(template, input(planJson));
    expect(text).toContain('"goal": "items stack up to a per-type cap"');
    expect(text).toContain("repos:");
    expect(text).toContain("server:\n");
    expect(text).toContain("## server\ninventory/stack.go");
    expect(text).not.toContain("{{");
    expect(text).not.toContain("Revision");
    expect(text).not.toContain("failed these checks");
  });

  test("a revision shows the previous plan and the instructions", () => {
    const previous = { schema: 1, brief_hash: "h", tasks: [task], risks: [] } as unknown as Plan;
    const text = renderPlannerPrompt(
      template,
      input(planJson, { previous, instructions: "split T1 per criterion" }),
    );
    expect(text).toContain("### Revision");
    expect(text).toContain('"id": "T1"');
    expect(text).toContain("split T1 per criterion");
  });

  test("feedback lists the failed gates with their evidence", () => {
    const feedback: GateResult[] = [
      {
        gate: "criteria_covered",
        verdict: "fail",
        reason: "criteria are not covered",
        evidence: ["AC2: no test task covers it"],
      },
    ];
    const text = renderPlannerPrompt(template, input(planJson, { feedback }));
    expect(text).toContain("### Your previous answer failed these checks");
    expect(text).toContain(
      "- criteria_covered: criteria are not covered\n  - AC2: no test task covers it",
    );
  });

  test("feedback shows the previous output, truncated when huge, and asks for a correction", () => {
    const feedback: GateResult[] = [{ gate: "g", verdict: "fail", reason: "r", evidence: [] }];
    const text = renderPlannerPrompt(
      template,
      input(planJson, { feedback, previousOutput: '{"schema":1,"tasks":[]}' }),
    );
    expect(text).toContain("### Your previous answer");
    expect(text).toContain('{"schema":1,"tasks":[]}');
    expect(text).toContain("corrected");
    const big = renderPlannerPrompt(
      template,
      input(planJson, { feedback, previousOutput: "x".repeat(100_000) }),
    );
    expect(big.length).toBeLessThan(60_000);
    expect(big).toContain("truncated");
  });
});

describe("repoMapFromFiles", () => {
  test("one section per project, trimmed", () => {
    const files = { server: Array.from({ length: 5 }, (_, i) => `f${i}.go`), web: [] };
    expect(repoMapFromFiles(files, 3)).toBe(
      "## server\nf0.go\nf1.go\nf2.go\n(2 more files)\n\n## web\n(no tracked files)",
    );
  });
});
