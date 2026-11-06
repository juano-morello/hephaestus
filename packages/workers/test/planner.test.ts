import { describe, expect, test } from "bun:test";
import { briefHash, type GateResult, type Plan } from "@hephaestus/core";
import {
  type PlannerSession,
  pathsInEvidence,
  renderPlannerPrompt,
  repoMapFromFiles,
  runPlanner,
  textOf,
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

  test("an empty or errored answer is a transport failure, not a bad plan", async () => {
    const run = (last: unknown) =>
      runPlanner({
        ...input(""),
        createSession: async () => {
          const s = (await fake("").createSession({})).session;
          return { session: { ...s, getLastAssistantMessage: () => last as never } };
        },
      });
    const aborted = await run({ stopReason: "aborted", errorMessage: "Request was aborted" });
    expect(aborted.transport).toContain("Request was aborted");
    expect(aborted.evaluation).toMatchObject({ valid: false, failures: ["transport"] });
    expect(aborted.output).toBe("");
    const empty = await run({ stopReason: "stop", content: [] });
    expect(empty.transport).toContain("no text");
    const none = await run(undefined);
    expect(none.transport).toBeDefined();
    const cut = await run({
      stopReason: "length",
      content: [{ type: "text", text: '{"schema":1,"ta' }],
    });
    expect(cut.transport).toContain("length");
    expect(cut.evaluation.failures).toEqual(["transport"]);
    expect(cut.output).toBe('{"schema":1,"ta');
  });

  test("the file list reaches the plan gates", async () => {
    const r = await runPlanner(
      input(
        JSON.stringify({
          schema: 1,
          // Test tasks may create new directories, so the guess has to come from an implement task.
          tasks: [{ ...task, kind: "implement", scope: ["nowhere/*.go"] }],
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
  const many = (dir: string, n: number) => Array.from({ length: n }, (_, i) => `${dir}/f${i}.go`);
  const big = {
    server: ["go.mod", ...many("world", 150), ...many("net", 150), ...many("util", 100)],
  };
  const lines = (map: string) => map.split("\n");

  test("a small project renders as a flat list; an empty one says so", () => {
    const files = { server: ["a.go", "b/c.go"], web: [] };
    expect(repoMapFromFiles(files)).toBe("## server\na.go\nb/c.go\n\n## web\n(no tracked files)");
  });

  test("a large project collapses directories the Brief does not mention", () => {
    const map = repoMapFromFiles(big, { brief: "fix world/f3.go" });
    expect(map).toContain("world/f3.go");
    expect(map).toContain("world/f149.go");
    expect(map).toContain("net/ (150 files)");
    expect(map).toContain("util/ (100 files)");
    expect(map).toContain("go.mod");
    expect(map).toContain("(listing is partial");
    expect(lines(map).length).toBeLessThanOrEqual(200 + 3);
  });

  test("a failure path expands its directory on the retry", () => {
    const map = repoMapFromFiles(big, { brief: "", focus: ["net/f1.go"] });
    expect(map).toContain("net/f149.go");
    expect(map).toContain("world/ (150 files)");
  });

  test("Brief text with regex characters never throws", () => {
    expect(() => repoMapFromFiles(big, { brief: "a.*(b[ \\" })).not.toThrow();
  });

  test("one directory far over budget is cut and says the listing is partial", () => {
    const map = repoMapFromFiles({ server: many("big", 500) }, { brief: "big" });
    expect(lines(map).length).toBeLessThanOrEqual(200 + 3);
    expect(map).toContain("(listing is partial");
    expect(map).toContain("more files)");
  });

  test("a nested directory named by a failure or the Brief is listed, not shadowed by its parent", () => {
    const nested = {
      server: Array.from({ length: 30 }, (_, d) =>
        Array.from({ length: 20 }, (_, i) => `src/pkg${String(d).padStart(2, "0")}/f${i}.go`),
      ).flat(),
    };
    expect(repoMapFromFiles(nested, { focus: ["src/pkg25/cap.go"] })).toContain("src/pkg25/f0.go");
    expect(repoMapFromFiles(nested, { brief: "change src/pkg25/f3.go" })).toContain(
      "src/pkg25/f0.go",
    );
  });

  test("the Brief is matched on word boundaries, not inside other words", () => {
    const dirs = ["app", "lib", "cli", "core", "zzz"];
    const files = { server: dirs.flatMap((d) => many(d, 80)) };
    const map = repoMapFromFiles(files, {
      brief: "Happen: the client library score; change zzz/f1.go",
      maxLines: 100,
    });
    expect(map).toContain("zzz/f1.go");
    for (const d of ["app", "lib", "cli", "core"]) expect(map).toContain(`${d}/ (80 files)`);
  });

  test("maxLines is honoured", () => {
    const files = { server: Array.from({ length: 5 }, (_, i) => `f${i}.go`) };
    const map = repoMapFromFiles(files, { maxLines: 3 });
    expect(lines(map).length).toBeLessThanOrEqual(3 + 3);
    expect(map).toContain("f0.go");
  });
});

describe("textOf", () => {
  test("joins the string values of a structure and ignores its keys", () => {
    expect(textOf({ constraints: ["use core"], nested: { goal: "ship it" }, n: 3 })).toBe(
      "use core\nship it",
    );
  });
});

describe("pathsInEvidence", () => {
  test("takes every path-looking token from gate evidence, without trailing punctuation", () => {
    const gate: GateResult = {
      gate: "scope_paths",
      verdict: "fail",
      reason: "x",
      evidence: [
        "T1: inventory/cap.go does not exist and is not in creates (closest existing: inventory/stack.go)",
      ],
    };
    expect(pathsInEvidence([gate])).toEqual(["inventory/cap.go", "inventory/stack.go"]);
  });
});
