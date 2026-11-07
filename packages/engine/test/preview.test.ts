import { describe, expect, test } from "bun:test";
import type { Criterion, Plan, RouteSignals, Task, Workspace } from "@hephaestus/core";
import type { EngineConfig } from "../src/config.ts";
import { previewRun } from "../src/preview.ts";
import { config, crossRepoPlan } from "./workspace.ts";

const workspace: Workspace = {
  repos: { proto: "./proto", server: "./server", web: "./web" },
  projects: {
    proto: { repo: "proto", path: ".", stack: "schema" },
    server: { repo: "server", path: ".", stack: "sh", depends_on: ["proto"] },
    web: { repo: "web", path: ".", stack: "ts" },
  },
};

const big: RouteSignals = {
  files: 6,
  lines: 500,
  criteria: 1,
  crossProject: false,
  planner: "standard",
};
const small: RouteSignals = {
  files: 1,
  lines: 10,
  criteria: 0,
  crossProject: false,
  planner: "trivial",
};

const preview = (o: {
  plan?: Plan;
  config?: EngineConfig;
  signals?: RouteSignals;
  criteria?: Criterion[];
  prompts?: { role: string; path: string; layer: "home" | "repo" | "workspace" }[];
}) =>
  previewRun({
    runId: "R1",
    plan: o.plan ?? crossRepoPlan(),
    workspace,
    config: o.config ?? config,
    criteria: o.criteria ?? [],
    signals: async () => o.signals ?? big,
    ...(o.prompts ? { prompts: o.prompts } : {}),
  });

const task = (id: string, project: string, t: Partial<Task> = {}): Task => ({
  id,
  title: id,
  kind: "implement",
  project,
  lane: "contained",
  complexity: "standard",
  complexity_reason: "x",
  scope: [`${id}.txt`],
  covers: ["AC1"],
  spec: id,
  ...t,
});

describe("previewRun", () => {
  test("units come out in build order with the run header", async () => {
    const p = await preview({});
    expect(p.dry_run).toBe(true);
    expect(p.run_id).toBe("R1");
    expect(p.parallel).toBe(1);
    expect(p.units.map((u) => u.id)).toEqual(["P1", "S1", "S2"]);
    expect(p.units.map((u) => u.role)).toEqual(["implementer", "test_author", "implementer"]);
  });

  test("at parallel 1 the waves are one unit each", async () => {
    expect((await preview({})).waves).toEqual([["P1"], ["S1"], ["S2"]]);
  });

  test("independent units in different projects share a wave at parallel 2", async () => {
    const plan: Plan = {
      ...crossRepoPlan(),
      tasks: [task("A", "proto"), task("B", "web")],
    };
    const p = await preview({ plan, config: { ...config, parallel: 2 } });
    expect(p.waves).toEqual([["A", "B"]]);
    const serial = await preview({ plan });
    expect(serial.waves).toEqual([["A"], ["B"]]);
  });

  test("a test unit locks the later units of its project that depend on it", async () => {
    const p = await preview({});
    const by = Object.fromEntries(p.units.map((u) => [u.id, u]));
    expect(by.S2?.locked_by).toEqual(["S1"]);
    expect(by.P1?.locked_by).toEqual([]);
    expect(by.S1?.locked_by).toEqual([]);
  });

  test("routes come from the config; top and fallback only where configured", async () => {
    const cfg: EngineConfig = {
      ...config,
      routing: {
        test_author: { default: { model: "claude/sonnet" } },
        implementer: {
          default: { model: "claude/sonnet", effort: "medium" },
          top: { model: "claude/opus", effort: "high" },
          fallback: { model: "openai/gpt-5" },
        },
      },
    };
    const p = await preview({ config: cfg });
    const by = Object.fromEntries(p.units.map((u) => [u.id, u]));
    expect(by.S2?.route).toEqual({ model: "claude/sonnet", effort: "medium" });
    expect(by.S2?.top).toEqual({ model: "claude/opus", effort: "high" });
    expect(by.S2?.fallback).toEqual({ model: "openai/gpt-5" });
    expect(by.S1?.route).toEqual({ model: "claude/sonnet" });
    expect("top" in (by.S1 ?? {})).toBe(false);
    expect("fallback" in (by.S1 ?? {})).toBe(false);
  });

  test("the start tier comes from the router signals, with the reasons", async () => {
    const p = await preview({ signals: small });
    const u = p.units.find((x) => x.id === "S2");
    expect(u?.start_tier).toBe("trivial");
    expect(u?.planner_tier).toBe("standard");
    expect(u?.reasons).toContain("1 files");
    expect(typeof u?.score).toBe("number");
    const heavy = await preview({ signals: big });
    expect(heavy.units.find((x) => x.id === "S2")?.start_tier).not.toBe("trivial");
  });

  test("the attempt timeout follows the tier, then the default, else is omitted", async () => {
    const none = await preview({ signals: small });
    expect("attempt_timeout_ms" in (none.units[0] ?? {})).toBe(false);
    const dflt = await preview({ signals: small, config: { ...config, attemptTimeoutMs: 5000 } });
    expect(dflt.units[0]?.attempt_timeout_ms).toBe(5000);
    const byTier = await preview({
      signals: small,
      config: { ...config, attemptTimeoutMs: 5000, attemptTimeoutByTier: { trivial: 1000 } },
    });
    expect(byTier.units[0]?.attempt_timeout_ms).toBe(1000);
  });

  test("prompts pass through", async () => {
    const prompts = [{ role: "planner", path: "/x/planner.md", layer: "home" as const }];
    const p = await preview({ prompts });
    expect(p.prompts).toEqual(prompts);
    expect((await preview({})).prompts).toEqual([]);
  });

  describe("gates", () => {
    const builtin = ["diff_scope", "locked_paths", "touched_vs_diff", "tests", "typecheck", "lint"];
    const buf: Criterion = {
      id: "AC1",
      text: "buf passes",
      kind: "behavior",
      check: { gate: "buf" },
    };
    const custom: EngineConfig = {
      ...config,
      customGates: {
        server: {
          buf: { command: "buf lint", always: false },
          nc: { command: "./nc.sh", always: true },
        },
      },
    };
    const gatesOf = async (o: Parameters<typeof preview>[0]) =>
      Object.fromEntries((await preview(o)).units.map((u) => [u.id, u.gates]));

    test("an implement unit lists the six built-in gates", async () => {
      expect((await gatesOf({})).S2).toEqual(builtin);
    });

    test("a unit covering a gate-checked criterion lists the gate last", async () => {
      const by = await gatesOf({ config: custom, criteria: [buf] });
      expect(by.S2).toEqual([...builtin, "buf", "nc"]);
      expect(by.P1).toEqual(builtin);
    });

    test("an always gate is on every unit of its project, test units included", async () => {
      const by = await gatesOf({ config: custom, criteria: [] });
      expect(by.S1).toEqual([...builtin, "nc"]);
      expect(by.S2).toEqual([...builtin, "nc"]);
    });

    test("a test unit lists no criterion-named gate", async () => {
      const plan: Plan = {
        ...crossRepoPlan(),
        tasks: [task("T", "server", { kind: "test", covers: ["AC1"] })],
      };
      const by = await gatesOf({ plan, config: custom, criteria: [buf] });
      expect(by.T).toEqual([...builtin, "nc"]);
    });
  });
});
