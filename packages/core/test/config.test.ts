import { describe, expect, test } from "bun:test";
import {
  defaultConfig,
  HomeConfigLayer,
  Limits,
  normalizeGates,
  ProjectLayer,
  ProjectSettings,
  RESERVED_GATE_NAMES,
  RepoConfigLayer,
  ResolvedConfig,
  RoleRoutes,
  WorkspaceConfig,
} from "../src/schemas/config.ts";
import { workspace } from "./helpers.ts";

const resolved = () => ({
  ...defaultConfig({ nodeId: "mbp" }),
  workspace: workspace(),
  projects: { server: { commands: { test: "go test ./..." } } },
});

describe("defaultConfig", () => {
  test("uses SPEC section 10 routing", () => {
    const d = defaultConfig({ nodeId: "mbp" });
    expect(d.routing.planner?.default).toEqual({ model: "claude/claude-opus-5-5", effort: "high" });
    expect(d.routing.implementer?.trivial).toEqual({ model: "claude/claude-haiku-5-5" });
    expect(d.routing.implementer?.standard).toEqual({
      model: "claude/claude-sonnet-5-5",
      effort: "medium",
    });
    expect(d.routing.test_author?.complex).toEqual({
      model: "claude/claude-sonnet-5-5",
      effort: "high",
    });
    expect(d.routing.documenter?.default).toEqual({ model: "claude/claude-haiku-5-5" });
  });

  test("uses the built-in limits and sandbox", () => {
    const d = defaultConfig({ nodeId: "mbp" });
    expect(d.node).toEqual({ id: "mbp" });
    expect(d.limits).toEqual({
      attempts_per_unit: 3,
      budget_tokens: 20000,
      gate_timeout_ms: 600000,
      attempt_timeout_ms: 1200000,
      idle_timeout_ms: 600000,
      transport_retries: 2,
      parallel: 3,
    });
    expect(d.sandbox).toEqual({ mode: "native", runtime: "docker", image: "alpine:3.20" });
  });
});

describe("top and fallback routes", () => {
  const opus = { model: "claude/claude-opus-5-5", effort: "high" };
  test("RoleRoutes accepts top and fallback and still rejects unknown keys", () => {
    const route = { model: "claude/claude-sonnet-5-5" };
    expect(
      RoleRoutes.safeParse({ complex: route, top: route, fallback: { model: "x/y" } }).success,
    ).toBe(true);
    expect(RoleRoutes.safeParse({ complex: route, bogus: route }).success).toBe(false);
  });
  test("defaults give implementer and test_author an opus top and no fallback", () => {
    const r = defaultConfig({ nodeId: "n" }).routing;
    expect(r.implementer?.top).toEqual(opus);
    expect(r.test_author?.top).toEqual(opus);
    expect(r.documenter?.top).toBeUndefined();
    expect(r.planner?.top).toBeUndefined();
    for (const role of Object.values(r)) expect(role.fallback).toBeUndefined();
  });
});

describe("attempt limits", () => {
  const limits = (extra: object) => ({ ...defaultConfig({ nodeId: "n" }).limits, ...extra });
  test("a per-tier timeout is optional and must be a positive integer for a known tier", () => {
    const ok = Limits.safeParse(limits({ attempt_timeout_ms_by_tier: { complex: 2_400_000 } }));
    expect(ok.success).toBe(true);
    expect(Limits.safeParse(limits({ attempt_timeout_ms_by_tier: { huge: 1 } })).success).toBe(
      false,
    );
    expect(Limits.safeParse(limits({ attempt_timeout_ms_by_tier: { complex: 0 } })).success).toBe(
      false,
    );
    expect(Limits.safeParse(limits({ transport_retries: 0 })).success).toBe(true);
    expect(Limits.safeParse(limits({ transport_retries: -1 })).success).toBe(false);
  });
});

describe("ResolvedConfig", () => {
  test("accepts defaults plus a workspace", () => {
    expect(ResolvedConfig.safeParse(resolved()).success).toBe(true);
  });

  test("rejects an unknown sandbox mode", () => {
    const c = resolved();
    const r = ResolvedConfig.safeParse({ ...c, sandbox: { ...c.sandbox, mode: "vm" } });
    expect(r.success).toBe(false);
  });

  test("rejects settings for a project the workspace does not have", () => {
    const r = ResolvedConfig.safeParse({ ...resolved(), projects: { mobile: { commands: {} } } });
    expect(r.error?.issues[0]?.path).toEqual(["projects", "mobile"]);
  });

  test("rejects a non-positive attempt limit", () => {
    const c = resolved();
    const r = ResolvedConfig.safeParse({ ...c, limits: { ...c.limits, attempts_per_unit: 0 } });
    expect(r.success).toBe(false);
  });
});

describe("WorkspaceConfig", () => {
  test("accepts targets for known repos", () => {
    expect(WorkspaceConfig.safeParse({ ...workspace(), targets: { server: "main" } }).success).toBe(
      true,
    );
  });

  test("rejects a target for an unknown repo", () => {
    const r = WorkspaceConfig.safeParse({ ...workspace(), targets: { mobile: "main" } });
    expect(r.error?.issues[0]?.path).toEqual(["targets", "mobile"]);
  });

  test("keeps the Workspace checks", () => {
    const ws = workspace();
    const projects = { ...ws.projects, web: { repo: "web", path: ".", stack: "ts" } };
    expect(WorkspaceConfig.safeParse({ ...ws, projects }).success).toBe(false);
  });
});

describe("layers", () => {
  test("the home layer takes partial limits and routes", () => {
    const r = HomeConfigLayer.safeParse({
      limits: { attempts_per_unit: 5 },
      routing: { implementer: { complex: { model: "claude/opus" } } },
    });
    expect(r.success).toBe(true);
  });

  test("the home layer rejects workspace keys", () => {
    expect(HomeConfigLayer.safeParse({ repos: { a: "." } }).success).toBe(false);
  });

  test("the home layer rejects an unknown tier", () => {
    const r = HomeConfigLayer.safeParse({ routing: { implementer: { huge: { model: "x" } } } });
    expect(r.success).toBe(false);
  });

  test("the repo layer takes projects or the project shorthand", () => {
    expect(
      RepoConfigLayer.safeParse({ projects: { server: { commands: { test: "go test" } } } })
        .success,
    ).toBe(true);
    expect(
      RepoConfigLayer.safeParse({ project: { gates: ["buf"], image: "golang:1.24" } }).success,
    ).toBe(true);
  });

  test("the repo layer rejects both forms at once", () => {
    const r = RepoConfigLayer.safeParse({ project: {}, projects: { server: {} } });
    expect(r.success).toBe(false);
  });

  test("the repo layer rejects an unknown command", () => {
    expect(RepoConfigLayer.safeParse({ project: { commands: { build: "make" } } }).success).toBe(
      false,
    );
  });
});

describe("custom gates config", () => {
  const layer = (gates: unknown) => ProjectLayer.safeParse({ gates });

  test("the layer takes a list, a command string or an object spec", () => {
    expect(layer(["buf"]).success).toBe(true);
    expect(layer({ buf: "buf lint" }).success).toBe(true);
    expect(layer({ buf: { command: "buf lint", timeout_ms: 5000 } }).success).toBe(true);
    expect(layer({ nc: { command: "x", always: true } }).success).toBe(true);
  });

  test("reserved names are rejected in both forms", () => {
    expect(RESERVED_GATE_NAMES).toEqual([
      "tests",
      "typecheck",
      "lint",
      "diff_scope",
      "locked_paths",
      "touched_vs_diff",
    ]);
    expect(layer(["tests"]).success).toBe(false);
    const r = layer({ lint: "x" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(
      "lint is a built-in gate and cannot be redefined",
    );
  });

  test("always needs a command; unknown keys and a zero timeout are rejected", () => {
    const r = layer({ a: { always: true } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("always needs a command");
    expect(layer({ a: { command: "x", nope: 1 } }).success).toBe(false);
    expect(layer({ a: { command: "x", timeout_ms: 0 } }).success).toBe(false);
  });

  test("normalizeGates yields the resolved map", () => {
    expect(normalizeGates(["buf"])).toEqual({ buf: { always: false } });
    expect(normalizeGates({ buf: "buf lint" })).toEqual({
      buf: { command: "buf lint", always: false },
    });
    expect(normalizeGates({ nc: { command: "x", always: true } })).toEqual({
      nc: { command: "x", always: true },
    });
    expect(normalizeGates({ b: { command: "x", timeout_ms: 10 } })).toEqual({
      b: { command: "x", timeout_ms: 10, always: false },
    });
    expect(normalizeGates(undefined)).toBeUndefined();
  });

  test("ProjectSettings accepts the resolved map and rejects the list", () => {
    const base = { commands: {} };
    expect(
      ProjectSettings.safeParse({ ...base, gates: { buf: { command: "b", always: false } } })
        .success,
    ).toBe(true);
    expect(ProjectSettings.safeParse({ ...base, gates: ["buf"] }).success).toBe(false);
  });
});

describe("limits.parallel", () => {
  test("defaults to 3 and rejects 0", () => {
    expect(defaultConfig({ nodeId: "mbp" }).limits.parallel).toBe(3);
    const bad = { ...resolved(), limits: { ...resolved().limits, parallel: 0 } };
    expect(ResolvedConfig.safeParse(bad).success).toBe(false);
    expect(ResolvedConfig.safeParse(resolved()).success).toBe(true);
  });
});
