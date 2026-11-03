import { describe, expect, test } from "bun:test";
import { Brief, briefHash } from "../src/schemas/brief.ts";
import { Plan } from "../src/schemas/plan.ts";
import { Workspace } from "../src/schemas/workspace.ts";
import { brief, plan, task, workspace } from "./helpers.ts";

describe("Brief", () => {
  test("accepts a valid brief", () => {
    expect(Brief.safeParse(brief()).success).toBe(true);
  });

  test("rejects other schema versions", () => {
    expect(Brief.safeParse({ ...brief(), schema: 2 }).success).toBe(false);
  });

  test("rejects unknown fields", () => {
    expect(Brief.safeParse({ ...brief(), priority: "high" }).success).toBe(false);
  });

  test("rejects unknown criterion kinds", () => {
    const b = brief({ acceptance: [{ id: "AC1", text: "x", kind: "vibe" as "behavior" }] });
    expect(Brief.safeParse(b).success).toBe(false);
  });
});

describe("briefHash", () => {
  test("is independent of key order", () => {
    const a = brief();
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(briefHash(reordered)).toBe(briefHash(a));
  });

  test("changes when content changes", () => {
    expect(briefHash(brief({ goal: "other" }))).not.toBe(briefHash(brief()));
  });
});

describe("Plan", () => {
  test("accepts a valid plan", () => {
    expect(Plan.safeParse(plan([task("T1")])).success).toBe(true);
  });

  test("rejects declared edges", () => {
    const p = { ...plan([task("T1")]), edges: [{ from: "T1", to: "T2" }] };
    expect(Plan.safeParse(p).success).toBe(false);
  });

  test("rejects unknown task kinds and lanes", () => {
    expect(Plan.safeParse(plan([task("T1", { kind: "refactor" as "test" })])).success).toBe(false);
    expect(Plan.safeParse(plan([task("T1", { lane: "huge" as "wide" })])).success).toBe(false);
  });

  test("rejects a non-positive context budget", () => {
    const t = task("T1", { context_budget: { tokens: 0, reason: "none" } });
    expect(Plan.safeParse(plan([t])).success).toBe(false);
  });
});

describe("Workspace", () => {
  test("accepts the SPEC section 4 layout", () => {
    expect(Workspace.safeParse(workspace()).success).toBe(true);
  });

  test("rejects a project pointing at an unknown repo", () => {
    const ws = workspace();
    ws.projects.web = { repo: "web", path: ".", stack: "ts" };
    const result = Workspace.safeParse(ws);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('unknown repo "web"');
  });

  test("rejects depends_on an unknown project", () => {
    const ws = workspace();
    ws.projects.client = { repo: "client", path: ".", stack: "godot", depends_on: ["shared"] };
    const result = Workspace.safeParse(ws);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('unknown project "shared"');
  });
});
