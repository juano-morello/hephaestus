import { describe, expect, test } from "bun:test";
import {
  complexitySanity,
  consumesResolve,
  criteriaCovered,
  migrationIrreversible,
  parallelScopesDisjoint,
  projectsExist,
  runPlanGates,
  sizeLimits,
  testPrecedesImplement,
} from "../src/gates/plan.ts";
import { DEFAULT_LIMITS, type GateContext } from "../src/gates/types.ts";
import { brief, gates, plan, task, workspace } from "./helpers.ts";

const ctx = (overrides: Partial<GateContext> = {}): GateContext => ({
  brief: brief(),
  workspace: workspace(),
  limits: DEFAULT_LIMITS,
  projectGates: gates(),
  ...overrides,
});

// A minimal plan that passes every gate: locked test first, implementation consumes it.
const goodPlan = () =>
  plan([
    task("T1", {
      kind: "test",
      covers: ["AC1"],
      scope: ["inventory/*_test.go"],
      produces: ["test:StackCap"],
    }),
    task("T2", {
      kind: "implement",
      covers: ["AC1"],
      scope: ["inventory/stack.go"],
      consumes: ["test:StackCap"],
      produces: ["fn:StackItems"],
    }),
  ]);

describe("runPlanGates", () => {
  test("a well-formed plan passes every gate", () => {
    const results = runPlanGates(goodPlan(), ctx());
    expect(results.filter((r) => r.verdict === "fail")).toEqual([]);
    expect(results.map((r) => r.gate)).toEqual([
      "projects_exist",
      "criteria_covered",
      "consumes_resolve",
      "test_precedes_implement",
      "parallel_scope_disjoint",
      "migration_irreversible",
      "complexity_sanity",
      "size_limits",
    ]);
  });
});

describe("projects_exist", () => {
  test("passes when every task targets a workspace project", () => {
    expect(projectsExist(goodPlan(), ctx()).verdict).toBe("pass");
  });

  test("fails on an unknown project", () => {
    const result = projectsExist(plan([task("T1", { project: "mobile" })]), ctx());
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(['T1: project "mobile" is not in the workspace']);
  });
});

describe("criteria_covered", () => {
  test("passes when every criterion has a test task", () => {
    expect(criteriaCovered(goodPlan(), ctx()).verdict).toBe("pass");
  });

  test("fails when a criterion is covered only by an implement task", () => {
    const p = plan([task("T1", { kind: "implement", covers: ["AC1"] })]);
    const result = criteriaCovered(p, ctx());
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(["AC1: no test task covers it"]);
  });

  test("lists every uncovered criterion", () => {
    const b = brief({
      acceptance: [
        { id: "AC1", text: "a", kind: "behavior" },
        { id: "AC2", text: "b", kind: "nonfunctional" },
      ],
    });
    const result = criteriaCovered(goodPlan(), ctx({ brief: b }));
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(["AC2: no test task covers it"]);
  });

  describe("gate-checked criteria", () => {
    const gated = brief({
      acceptance: [
        { id: "AC1", text: "stacks cap at max", kind: "behavior" },
        { id: "AC2", text: "buf passes", kind: "behavior", check: { gate: "buf" } },
      ],
    });
    const proto = (covers: string[]) =>
      task("P1", { kind: "codegen", project: "proto", scope: ["messages/loot.proto"], covers });

    test("passes when a task in a project with the gate covers it", () => {
      const p = goodPlan();
      p.tasks.push(proto(["AC2"]));
      expect(criteriaCovered(p, ctx({ brief: gated })).verdict).toBe("pass");
    });

    test("fails when no task covers it", () => {
      const result = criteriaCovered(goodPlan(), ctx({ brief: gated }));
      expect(result.verdict).toBe("fail");
      expect(result.evidence).toEqual([
        'AC2: checked by gate "buf" but no task in a project with that gate covers it',
      ]);
    });

    test("fails when the covering task's project lacks the gate", () => {
      const p = goodPlan();
      p.tasks.push(task("T3", { kind: "codegen", scope: ["internal/pb/**"], covers: ["AC2"] }));
      const result = criteriaCovered(p, ctx({ brief: gated }));
      expect(result.evidence).toEqual([
        'AC2: checked by gate "buf" but no task in a project with that gate covers it',
      ]);
    });

    test("fails a test task that claims a gate-checked criterion", () => {
      const p = goodPlan();
      p.tasks.push(proto(["AC2"]));
      p.tasks[0]?.covers.push("AC2");
      const result = criteriaCovered(p, ctx({ brief: gated }));
      expect(result.verdict).toBe("fail");
      expect(result.evidence).toEqual(['T1: test task covers AC2, which is checked by gate "buf"']);
    });
  });

  test("fails when a task covers an id the brief does not define", () => {
    const p = goodPlan();
    p.tasks[0]?.covers.push("AC9");
    const result = criteriaCovered(p, ctx());
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(['T1: covers unknown criterion "AC9"']);
  });
});

describe("consumes_resolve", () => {
  test("passes when every consumes has one producer and the graph is acyclic", () => {
    expect(consumesResolve(goodPlan()).verdict).toBe("pass");
  });

  test("fails on a consumes with no producer", () => {
    const p = plan([task("T1", { consumes: ["proto:LootMsg"] })]);
    const result = consumesResolve(p);
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(['T1: consumes "proto:LootMsg" but no task produces it']);
  });

  test("fails on an artifact with more than one producer", () => {
    const p = plan([
      task("T1", { produces: ["fn:StackItems"] }),
      task("T2", { produces: ["fn:StackItems"] }),
    ]);
    const result = consumesResolve(p);
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(['"fn:StackItems" is produced by T1, T2']);
  });

  test("fails on a cycle and shows the path", () => {
    const p = plan([
      task("T1", { produces: ["fn:A"], consumes: ["fn:B"] }),
      task("T2", { produces: ["fn:B"], consumes: ["fn:A"] }),
    ]);
    const result = consumesResolve(p);
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(["cycle: T1 -> T2 -> T1"]);
  });
});

describe("test_precedes_implement", () => {
  test("passes when a covering test task precedes the implement task", () => {
    expect(testPrecedesImplement(goodPlan()).verdict).toBe("pass");
  });

  test("passes when the test precedes transitively", () => {
    const p = plan([
      task("T1", { kind: "test", covers: ["AC1"], produces: ["test:Cap"] }),
      task("T2", { kind: "codegen", consumes: ["test:Cap"], produces: ["gen:x"] }),
      task("T3", { kind: "implement", covers: ["AC1"], consumes: ["gen:x"] }),
    ]);
    expect(testPrecedesImplement(p).verdict).toBe("pass");
  });

  test("fails when no test task covers the implement task's criteria", () => {
    const p = plan([task("T1", { kind: "implement", covers: ["AC1"] })]);
    const result = testPrecedesImplement(p);
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(["T1: no test task in project server covers AC1"]);
  });

  test("fails when the matching test does not precede it in the derived graph", () => {
    const p = plan([
      task("T1", { kind: "test", covers: ["AC1"], produces: ["test:Cap"] }),
      task("T2", { kind: "implement", covers: ["AC1"] }),
    ]);
    const result = testPrecedesImplement(p);
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual([
      "T2: test T1 covers AC1 but does not precede it (consume one of: test:Cap)",
    ]);
  });

  test("fails when the only matching test is in another project", () => {
    const p = plan([
      task("T1", { kind: "test", project: "client", covers: ["AC1"], produces: ["test:Cap"] }),
      task("T2", { kind: "implement", covers: ["AC1"], consumes: ["test:Cap"] }),
    ]);
    const result = testPrecedesImplement(p);
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(["T2: no test task in project server covers AC1"]);
  });

  test("fails when an implement task covers nothing", () => {
    const result = testPrecedesImplement(plan([task("T1", { kind: "implement", covers: [] })]));
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(["T1: implement task covers no criteria"]);
  });

  test("ignores non-implement tasks", () => {
    const p = plan([task("T1", { kind: "docs" }), task("T2", { kind: "codegen" })]);
    expect(testPrecedesImplement(p).verdict).toBe("pass");
  });
});

describe("parallel_scope_disjoint", () => {
  test("passes when ordered tasks share scope", () => {
    const p = plan([
      task("T1", { scope: ["inventory/**"], produces: ["fn:A"] }),
      task("T2", { scope: ["inventory/stack.go"], consumes: ["fn:A"] }),
    ]);
    expect(parallelScopesDisjoint(p).verdict).toBe("pass");
  });

  test("passes when parallel tasks are in different projects", () => {
    const p = plan([
      task("T1", { project: "server", scope: ["net/**"] }),
      task("T2", { project: "client", scope: ["net/**"] }),
    ]);
    expect(parallelScopesDisjoint(p).verdict).toBe("pass");
  });

  test("fails when parallel tasks in one project overlap and names the globs", () => {
    const p = plan([
      task("T1", { scope: ["inventory/**/*.go"] }),
      task("T2", { scope: ["loot/drop.go", "inventory/stack.go"] }),
    ]);
    const result = parallelScopesDisjoint(p);
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(["T1 x T2: inventory/**/*.go overlaps inventory/stack.go"]);
  });
});

describe("migration_irreversible", () => {
  test("passes an irreversible migration", () => {
    const p = plan([task("T1", { kind: "migration", lane: "irreversible" })]);
    expect(migrationIrreversible(p).verdict).toBe("pass");
  });

  test("fails a migration in another lane", () => {
    const p = plan([task("T1", { kind: "migration", lane: "wide" })]);
    const result = migrationIrreversible(p);
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(['T1: migration must be lane irreversible, got "wide"']);
  });
});

describe("complexity_sanity", () => {
  test("reports no bumps for a sane plan", () => {
    const result = complexitySanity(goodPlan(), ctx());
    expect(result).toMatchObject({ verdict: "pass", evidence: [], bumps: [] });
  });

  test("bumps wide trivial to standard and passes", () => {
    const p = plan([task("T1", { lane: "wide", complexity: "trivial" })]);
    const result = complexitySanity(p, ctx());
    expect(result.verdict).toBe("pass");
    expect(result.evidence).toEqual(["T1: trivial -> standard (lane wide)"]);
    expect(result.bumps).toEqual([{ task: "T1", from: "trivial", to: "standard" }]);
  });

  test("bumps a task consuming from another project", () => {
    const p = plan([
      task("T1", { project: "proto", produces: ["proto:LootMsg"] }),
      task("T2", { complexity: "trivial", consumes: ["proto:LootMsg"] }),
    ]);
    const result = complexitySanity(p, ctx());
    expect(result.evidence).toEqual([
      "T2: trivial -> standard (consumes proto:LootMsg from project proto)",
    ]);
  });

  test("bumps a wide scope to complex", () => {
    const scope = ["a/*", "b/*", "c/*", "d/*", "e/*", "f/*"];
    const p = plan([task("T1", { complexity: "standard", scope })]);
    const result = complexitySanity(p, ctx());
    expect(result.evidence).toEqual(["T1: standard -> complex (6 scope globs > 5)"]);
  });

  test("never lowers a tier", () => {
    const p = plan([task("T1", { complexity: "complex" })]);
    expect(complexitySanity(p, ctx()).bumps).toEqual([]);
  });
});

describe("size_limits", () => {
  test("passes a small plan", () => {
    expect(sizeLimits(goodPlan(), ctx()).verdict).toBe("pass");
  });

  test("fails when there are too many tasks", () => {
    const p = plan([task("T1"), task("T2"), task("T3")]);
    const result = sizeLimits(p, ctx({ limits: { ...DEFAULT_LIMITS, maxTasks: 2 } }));
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(["3 tasks > limit 2"]);
  });

  test("fails a task with too many scope globs", () => {
    const p = plan([task("T1", { scope: ["a", "b", "c"] })]);
    const result = sizeLimits(p, ctx({ limits: { ...DEFAULT_LIMITS, maxScopeGlobs: 2 } }));
    expect(result.evidence).toEqual(["T1: 3 scope globs > limit 2"]);
  });

  test("fails unbounded and empty scopes", () => {
    const p = plan([task("T1", { scope: ["**"] }), task("T2", { scope: [] })]);
    const result = sizeLimits(p, ctx());
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(['T1: unbounded scope "**"', "T2: empty scope"]);
  });
});
