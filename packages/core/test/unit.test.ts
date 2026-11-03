import { describe, expect, test } from "bun:test";
import { ContextPack, UnitBrief, WorkerResult } from "../src/schemas/unit.ts";
import { task } from "./helpers.ts";

const pack = (): ContextPack => ({
  schema: 1,
  budget_tokens: 32_000,
  project: { name: "server", stack: "go", commands: { test: "go test ./..." } },
  conventions: "",
  repo_map: "",
  files: [{ path: "a.go", content: "package a", why: "scope" }],
  contracts: [],
  locked: [{ path: "a_test.go", content: "package a" }],
  constraints: ["no new goroutines"],
});

describe("WorkerResult", () => {
  test("accepts a result and an honest blocked exit", () => {
    const r = { schema: 1, summary: "done", claims: ["cap enforced"], touched: ["a.go"] };
    expect(WorkerResult.safeParse(r).success).toBe(true);
    expect(WorkerResult.safeParse({ ...r, blocked: { reason: "test AC2 is wrong" } }).success).toBe(
      true,
    );
  });

  test("rejects extra fields and an empty blocked reason", () => {
    const r = { schema: 1, summary: "done", claims: [], touched: [] };
    expect(WorkerResult.safeParse({ ...r, confidence: 0.9 }).success).toBe(false);
    expect(WorkerResult.safeParse({ ...r, blocked: { reason: "" } }).success).toBe(false);
  });
});

describe("ContextPack", () => {
  test("accepts a pack with full files", () => {
    expect(ContextPack.safeParse(pack()).success).toBe(true);
  });

  test("a file carries exactly one of content or outline", () => {
    const both = { ...pack(), files: [{ path: "a.go", content: "x", outline: "y", why: "scope" }] };
    const neither = { ...pack(), files: [{ path: "a.go", why: "scope" }] };
    expect(ContextPack.safeParse(both).success).toBe(false);
    expect(ContextPack.safeParse(neither).success).toBe(false);
    const outline = { ...pack(), files: [{ path: "b.go", outline: "func B()", why: "neighbor" }] };
    expect(ContextPack.safeParse(outline).success).toBe(true);
  });
});

describe("UnitBrief", () => {
  test("accepts a brief built by the engine", () => {
    const brief = {
      schema: 1,
      task: task("T2", { covers: ["AC1"] }),
      criteria: [{ id: "AC1", text: "stacks cap at max_stack", kind: "behavior" }],
      decisions: ["the cap lives in the item table"],
      role: "implementer",
      tier: "standard",
      context: pack(),
      constraints: [],
      locked_paths: ["a_test.go"],
      output_schema: "WorkerResult",
    };
    expect(UnitBrief.safeParse(brief).success).toBe(true);
    expect(UnitBrief.safeParse({ ...brief, tier: "huge" }).success).toBe(false);
    const { criteria: _, ...noCriteria } = brief;
    expect(UnitBrief.safeParse(noCriteria).success).toBe(false);
  });
});
