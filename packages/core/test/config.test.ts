import { describe, expect, test } from "bun:test";
import {
  defaultConfig,
  HomeConfigLayer,
  RepoConfigLayer,
  ResolvedConfig,
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
    });
    expect(d.sandbox).toEqual({ mode: "native", runtime: "docker", image: "alpine:3.20" });
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
