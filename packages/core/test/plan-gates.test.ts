import { describe, expect, test } from "bun:test";
import {
  complexitySanity,
  consumesResolve,
  criteriaCovered,
  migrationIrreversible,
  parallelScopesDisjoint,
  projectsExist,
  runPlanGates,
  scopePaths,
  sizeLimits,
  testPrecedesImplement,
  testsPassable,
} from "../src/gates/plan.ts";
import { DEFAULT_LIMITS, type GateContext } from "../src/gates/types.ts";
import type { Workspace } from "../src/schemas/workspace.ts";
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
      "tests_passable",
      "parallel_scope_disjoint",
      "migration_irreversible",
      "complexity_sanity",
      "size_limits",
      "scope_paths",
    ]);
  });
});

describe("tests_passable", () => {
  test("passes when each task's tests check only work done by then", () => {
    expect(testsPassable(goodPlan(), ctx()).verdict).toBe("pass");
  });

  test("fails when a test checks a criterion whose task runs later (the zoom run)", () => {
    // T1 tests AC1 and AC2; T2 does AC1 but must pass every test, and AC2 waits for T3.
    const p = plan([
      task("T1", { kind: "test", covers: ["AC1", "AC2"], produces: ["test:Zoom"] }),
      task("T2", { covers: ["AC1"], consumes: ["test:Zoom"] }),
      task("T3", { kind: "docs", covers: ["AC2"], consumes: ["test:Zoom"] }),
    ]);
    const r = testsPassable(p, ctx());
    expect(r.verdict).toBe("fail");
    expect(r.evidence).toEqual([
      "T2: runs after test T1, which checks AC2, but AC2 is covered only by T3, which runs later. Every task must pass its project's tests, so cover AC2 in T2 or earlier, or test AC2 in a test task after T2",
    ]);
  });

  test("passes when the later criterion gets its own test task after the first work", () => {
    const p = plan([
      task("T1", { kind: "test", covers: ["AC1"], produces: ["test:A"] }),
      task("T2", { covers: ["AC1"], consumes: ["test:A"], produces: ["fn:A"] }),
      task("T3", { kind: "test", covers: ["AC2"], consumes: ["fn:A"], produces: ["test:B"] }),
      task("T4", { kind: "docs", covers: ["AC2"], consumes: ["test:B"] }),
    ]);
    expect(testsPassable(p, ctx()).verdict).toBe("pass");
  });

  test("only tests in the task's own project count: they are the ones its gate runs", () => {
    const p = plan([
      task("T1", { kind: "test", project: "client", covers: ["AC1", "AC2"], produces: ["test:C"] }),
      task("T2", { project: "server", covers: ["AC2"] }),
      task("T3", { project: "client", covers: ["AC1"], consumes: ["test:C"] }),
    ]);
    expect(testsPassable(p, ctx()).verdict).toBe("pass");
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

  describe("criteria with projects", () => {
    const multi = brief({
      acceptance: [{ id: "AC1", text: "a", kind: "behavior", projects: ["server", "client"] }],
    });
    const t = (id: string, project: string, covers: string[]) =>
      task(id, { kind: "test", project, scope: [`${id}/**/*.x`], covers });

    test("fails with one evidence line per project lacking a covering test", () => {
      const p = plan([t("T1", "server", ["AC1"])]);
      const result = criteriaCovered(p, ctx({ brief: multi }));
      expect(result.verdict).toBe("fail");
      expect(result.evidence).toEqual(["AC1: no test task in project client covers it"]);
    });

    test("a test task in the wrong project does not count", () => {
      const p = plan([t("T1", "server", ["AC1"]), t("T2", "proto", ["AC1"])]);
      const result = criteriaCovered(p, ctx({ brief: multi }));
      expect(result.evidence).toEqual(["AC1: no test task in project client covers it"]);
    });

    test("an implement task in the project does not count", () => {
      const p = plan([
        t("T1", "server", ["AC1"]),
        task("T2", { kind: "implement", project: "client", covers: ["AC1"] }),
      ]);
      const result = criteriaCovered(p, ctx({ brief: multi }));
      expect(result.evidence).toEqual(["AC1: no test task in project client covers it"]);
    });

    test("passes when covered in every listed project", () => {
      const p = plan([t("T1", "server", ["AC1"]), t("T2", "client", ["AC1"])]);
      expect(criteriaCovered(p, ctx({ brief: multi })).verdict).toBe("pass");
    });

    test("a criterion without projects is covered by any test task", () => {
      const p = plan([t("T1", "client", ["AC1"])]);
      expect(criteriaCovered(p, ctx()).verdict).toBe("pass");
      expect(criteriaCovered(plan([]), ctx()).evidence).toEqual(["AC1: no test task covers it"]);
    });

    test("an empty projects array behaves as absent", () => {
      const b = brief({
        acceptance: [{ id: "AC1", text: "a", kind: "behavior", projects: [] }],
      });
      expect(criteriaCovered(plan([t("T1", "client", ["AC1"])]), ctx({ brief: b })).verdict).toBe(
        "pass",
      );
    });
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
    expect(testPrecedesImplement(goodPlan(), ctx()).verdict).toBe("pass");
  });

  test("passes when the test precedes transitively", () => {
    const p = plan([
      task("T1", { kind: "test", covers: ["AC1"], produces: ["test:Cap"] }),
      task("T2", { kind: "codegen", consumes: ["test:Cap"], produces: ["gen:x"] }),
      task("T3", { kind: "implement", covers: ["AC1"], consumes: ["gen:x"] }),
    ]);
    expect(testPrecedesImplement(p, ctx()).verdict).toBe("pass");
  });

  test("fails when no test task covers the implement task's criteria", () => {
    const p = plan([task("T1", { kind: "implement", covers: ["AC1"] })]);
    const result = testPrecedesImplement(p, ctx());
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(["T1: no test task in project server covers AC1"]);
  });

  test("fails when the matching test does not precede it in the derived graph", () => {
    const p = plan([
      task("T1", { kind: "test", covers: ["AC1"], produces: ["test:Cap"] }),
      task("T2", { kind: "implement", covers: ["AC1"] }),
    ]);
    const result = testPrecedesImplement(p, ctx());
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
    const result = testPrecedesImplement(p, ctx());
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(["T2: no test task in project server covers AC1"]);
  });

  test("fails when an implement task covers nothing", () => {
    const result = testPrecedesImplement(
      plan([task("T1", { kind: "implement", covers: [] })]),
      ctx(),
    );
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(["T1: implement task covers no criteria"]);
  });

  test("fails an implement task whose covers are only gate-checked criteria", () => {
    const gated = brief({
      acceptance: [
        { id: "AC1", text: "a", kind: "behavior" },
        { id: "AC2", text: "buf passes", kind: "nonfunctional", check: { gate: "buf" } },
      ],
    });
    const p = plan([task("T1", { kind: "implement", covers: ["AC2"] })]);
    const result = testPrecedesImplement(p, ctx({ brief: gated }));
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual([
      "T1: implement task covers only gate-checked criteria (AC2); it needs a test-checked criterion",
    ]);
  });

  test("strict: every criterion the implement task covers needs a preceding test", () => {
    const two = brief({
      acceptance: [
        { id: "AC1", text: "a", kind: "behavior" },
        { id: "AC2", text: "b", kind: "behavior" },
      ],
    });
    const p = plan([
      task("T1", { kind: "test", covers: ["AC1"], produces: ["test:A"] }),
      task("T3", { kind: "implement", covers: ["AC1", "AC2"], consumes: ["test:A"] }),
    ]);
    expect(testPrecedesImplement(p, ctx({ brief: two })).evidence).toEqual([
      "T3: no test task in project server covers AC2",
    ]);
    p.tasks.push(task("T2", { kind: "test", covers: ["AC2"], produces: ["test:B"] }));
    expect(testPrecedesImplement(p, ctx({ brief: two })).evidence).toEqual([
      "T3: test T2 covers AC2 but does not precede it (consume one of: test:B)",
    ]);
    p.tasks[1]?.consumes?.push("test:B");
    expect(testPrecedesImplement(p, ctx({ brief: two })).verdict).toBe("pass");
  });

  test("ignores non-implement tasks", () => {
    const p = plan([task("T1", { kind: "docs" }), task("T2", { kind: "codegen" })]);
    expect(testPrecedesImplement(p, ctx()).verdict).toBe("pass");
  });
});

describe("parallel_scope_disjoint", () => {
  test("passes when ordered tasks share scope", () => {
    const p = plan([
      task("T1", { scope: ["inventory/**"], produces: ["fn:A"] }),
      task("T2", { scope: ["inventory/stack.go"], consumes: ["fn:A"] }),
    ]);
    expect(parallelScopesDisjoint(p, ctx()).verdict).toBe("pass");
  });

  test("passes when parallel tasks are in different projects", () => {
    const p = plan([
      task("T1", { project: "server", scope: ["net/**"] }),
      task("T2", { project: "client", scope: ["net/**"] }),
    ]);
    expect(parallelScopesDisjoint(p, ctx()).verdict).toBe("pass");
  });

  test("fails when parallel tasks in one project overlap and names the globs", () => {
    const p = plan([
      task("T1", { scope: ["inventory/**/*.go"] }),
      task("T2", { scope: ["loot/drop.go", "inventory/stack.go"] }),
    ]);
    const result = parallelScopesDisjoint(p, ctx());
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

describe("parallel_scope_disjoint across projects and with real files", () => {
  const mono: Workspace = {
    repos: { mono: "." },
    projects: {
      app: { repo: "mono", path: ".", stack: "go" },
      lib: { repo: "mono", path: "pkg/a", stack: "go" },
    },
  };

  test("projects with nested roots in one repo are compared repo-relative", () => {
    const p = plan([
      task("A", { project: "app", scope: ["pkg/a/x.go"] }),
      task("B", { project: "lib", scope: ["x.go"] }),
    ]);
    const r = parallelScopesDisjoint(p, ctx({ workspace: mono }));
    expect(r).toMatchObject({
      verdict: "fail",
      evidence: ["A x B: pkg/a/x.go overlaps pkg/a/x.go"],
    });
    const apart = plan([
      task("A", { project: "app", scope: ["cmd/*.go"] }),
      task("B", { project: "lib", scope: ["x.go"] }),
    ]);
    expect(parallelScopesDisjoint(apart, ctx({ workspace: mono })).verdict).toBe("pass");
  });

  test("with the file list, two globs that only look alike are disjoint", () => {
    const p = plan([task("A", { scope: ["a/foo*"] }), task("B", { scope: ["a/*bar"] })]);
    expect(parallelScopesDisjoint(p, ctx()).verdict).toBe("fail");
    const files = { server: ["a/foo.txt", "a/xbar"] };
    expect(parallelScopesDisjoint(p, ctx({ files })).verdict).toBe("pass");
  });

  test("with the file list, a shared existing file is named", () => {
    const p = plan([
      task("A", { scope: ["inventory/**"] }),
      task("B", { scope: ["inventory/*.go"] }),
    ]);
    const r = parallelScopesDisjoint(p, ctx({ files: { server: ["inventory/stack.go"] } }));
    expect(r.evidence).toEqual([
      "A x B: inventory/** and inventory/*.go both match inventory/stack.go",
    ]);
  });

  test("a glob that matches only new files still counts as a possible overlap", () => {
    const p = plan([
      task("A", { scope: ["inventory/*_test.go"] }),
      task("B", { scope: ["inventory/*.go"] }),
    ]);
    const r = parallelScopesDisjoint(p, ctx({ files: { server: ["inventory/stack.go"] } }));
    expect(r.evidence).toEqual(["A x B: inventory/*_test.go overlaps inventory/*.go"]);
  });
});

describe("scope_paths", () => {
  const files = { server: ["inventory/stack.go", "inventory/stack_test.go", "go.mod"] };

  test("is skipped without a file list", () => {
    expect(scopePaths(goodPlan(), ctx())).toMatchObject({
      verdict: "pass",
      reason: "skipped: no file list",
    });
  });

  test("existing paths, declared new files and matching globs pass; new files are listed", () => {
    const p = plan([
      task("T1", {
        scope: ["inventory/stack.go", "inventory/cap.go", "inventory/*.go", "README.md"],
        creates: ["inventory/cap.go", "README.md"],
      }),
    ]);
    expect(scopePaths(p, ctx({ files }))).toEqual({
      gate: "scope_paths",
      verdict: "pass",
      reason: "scopes match the repo",
      evidence: ["T1: new file inventory/cap.go", "T1: new file README.md"],
    });
  });

  test("a glob under an existing top-level directory may create new subdirectories", () => {
    const f = { client: ["godot/project.godot", "godot/scripts/a.gd"], server: files.server };
    const p = plan([
      task("T1", {
        project: "client",
        scope: ["godot/tests/**/*auth*.gd", "godot/tests/auth_test.gd"],
        creates: ["godot/tests/auth_test.gd"],
      }),
    ]);
    expect(scopePaths(p, ctx({ files: f }))).toMatchObject({
      verdict: "pass",
      evidence: ["T1: new file godot/tests/auth_test.gd"],
    });
  });

  test("a test task may create files and globs in new directories", () => {
    const p = plan([
      task("T1", {
        kind: "test",
        scope: ["internal/loadbot/testdata/*.ini", "internal/loadbot/x_test.go"],
        creates: ["internal/loadbot/x_test.go"],
      }),
    ]);
    expect(scopePaths(p, ctx({ files }))).toMatchObject({ verdict: "pass" });
  });

  test("a test task's literal new file needs creates too", () => {
    const p = plan([task("T1", { kind: "test", scope: ["inventory/new_test.go"] })]);
    expect(scopePaths(p, ctx({ files })).verdict).toBe("fail");
  });

  test("a guessed existing file fails with the closest existing names", () => {
    const p = plan([task("T1", { scope: ["inventory/cap.go"] })]);
    expect(scopePaths(p, ctx({ files }))).toEqual({
      gate: "scope_paths",
      verdict: "fail",
      reason: "scopes point at paths that do not exist or are not declared in creates",
      evidence: [
        "T1: inventory/cap.go does not exist and is not in creates (closest existing: inventory/stack.go, inventory/stack_test.go)",
      ],
    });
  });

  test("root-level guesses are compared with root-level files; a missing directory keeps its own message", () => {
    const f = { server: ["go.mod"] };
    const p = plan([task("T1", { scope: ["README.md"] })]);
    expect(scopePaths(p, ctx({ files: f })).evidence).toEqual([
      "T1: README.md does not exist and is not in creates (closest existing: go.mod)",
    ]);
    const q = plan([task("T1", { scope: ["inventory/cap.go"] })]);
    expect(scopePaths(q, ctx({ files: f })).evidence).toEqual([
      "T1: inventory/cap.go is in a directory that does not exist (inventory/)",
    ]);
  });

  test("a creates path that already exists fails", () => {
    const p = plan([
      task("T1", { scope: ["inventory/stack.go"], creates: ["inventory/stack.go"] }),
    ]);
    expect(scopePaths(p, ctx({ files })).evidence).toEqual([
      "T1: inventory/stack.go is in creates but already exists",
    ]);
  });

  test("a creates path outside the task scope fails", () => {
    const p = plan([task("T1", { scope: ["inventory/stack.go"], creates: ["inventory/cap.go"] })]);
    expect(scopePaths(p, ctx({ files })).evidence).toEqual([
      "T1: inventory/cap.go is in creates but outside the task scope",
    ]);
  });

  test("a leading ./ is rejected with a clear message", () => {
    const p = plan([
      task("T1", { scope: ["./inventory/cap.go"], creates: ["./inventory/cap.go"] }),
    ]);
    const ev = scopePaths(p, ctx({ files })).evidence;
    expect(ev).toContain("T1: ./inventory/cap.go is not project-relative; drop the leading ./");
  });

  test("a project with no tracked files passes when every literal path is declared", () => {
    const p = plan([task("T1", { scope: ["main.go"], creates: ["main.go"] })]);
    expect(scopePaths(p, ctx({ files: { server: [] } })).verdict).toBe("pass");
    const q = plan([task("T1", { scope: ["main.go"] })]);
    expect(scopePaths(q, ctx({ files: { server: [] } })).verdict).toBe("fail");
  });

  test("even a test task cannot escape the project", () => {
    const p = plan([task("T1", { kind: "test", scope: ["../outside/*.go", "/etc/*.conf"] })]);
    expect(scopePaths(p, ctx({ files })).verdict).toBe("fail");
  });

  test("paths and globs in directories that do not exist fail", () => {
    const p = plan([task("T1", { scope: ["internal/game/boot.go", "net/**/*.go"] })]);
    expect(scopePaths(p, ctx({ files }))).toMatchObject({
      verdict: "fail",
      evidence: [
        "T1: internal/game/boot.go is in a directory that does not exist (internal/game/)",
        "T1: net/**/*.go matches no files and net/ does not exist",
      ],
    });
  });
});
