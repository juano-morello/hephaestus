import { describe, expect, test } from "bun:test";
import type { UnitBrief } from "@hephaestus/core";
import { loadRolePrompt, ROLES, renderUnitPrompt } from "../src/prompt.ts";

const brief = (overrides: Partial<UnitBrief> = {}): UnitBrief => ({
  schema: 1,
  task: {
    id: "T2",
    title: "Cap stacks",
    kind: "implement",
    project: "server",
    lane: "contained",
    complexity: "standard",
    complexity_reason: "logic",
    scope: ["inventory/stack.go"],
    covers: ["AC1"],
    spec: "Make Add respect max_stack.",
  },
  criteria: [
    { id: "AC1", text: "Adding past max_stack starts a new slot", kind: "behavior" },
    { id: "AC5", text: "Full CI passes", kind: "nonfunctional", check: { gate: "ci" } },
  ],
  decisions: ["max_stack lives in the item table"],
  role: "implementer",
  tier: "standard",
  context: {
    schema: 1,
    budget_tokens: 20_000,
    project: { name: "server", stack: "go", commands: { test: "go test ./..." } },
    conventions: "",
    repo_map: "",
    files: [{ path: "inventory/stack.go", content: "package inventory\n", why: "scope" }],
    contracts: [],
    locked: [{ path: "inventory/stack_test.go", content: "package inventory // TestCap\n" }],
    constraints: ["no locks"],
  },
  constraints: ["no locks"],
  locked_paths: ["inventory/stack_test.go"],
  output_schema: "WorkerResult",
  ...overrides,
});

describe("renderUnitPrompt", () => {
  test("carries the task, scope, locks, files, commands and how to finish", () => {
    const text = renderUnitPrompt(brief());
    for (const part of [
      "# Task T2: Cap stacks",
      "Make Add respect max_stack.",
      "- inventory/stack.go",
      "## Locked files (never modify)\n\n- inventory/stack_test.go",
      "- no locks",
      "## Acceptance criteria this task covers\n\n- AC1: Adding past max_stack starts a new slot\n- AC5: Full CI passes (checked by the ci gate, not by a test)",
      "## Decisions (settled, do not reopen)\n\n- max_stack lives in the item table",
      "### inventory/stack.go\n\n```\npackage inventory\n```",
      "### inventory/stack_test.go (locked)\n\n```\npackage inventory // TestCap\n```",
      "- test: `go test ./...`",
      "call `submit_result` exactly once",
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain("## Feedback");
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });

  test("includes the previous attempt's failures when there is feedback", () => {
    const text = renderUnitPrompt(
      brief({
        feedback: {
          schema: 1,
          unit_id: "T2",
          attempt: 1,
          verdict: "red",
          reasons: [
            { gate: "tests", reason: "1 test failed", evidence: "stack_test.go:12 want 50 got 51" },
          ],
          scope: ["inventory/stack.go"],
          instruction: "fix only the listed failures; do not modify locked paths",
        },
      }),
    );
    expect(text).toContain("## Feedback from attempt 1");
    expect(text).toContain("- tests: 1 test failed\n\n```\nstack_test.go:12 want 50 got 51\n```");
    expect(text).toContain("fix only the listed failures; do not modify locked paths");
  });

  test("says so when nothing is locked", () => {
    const text = renderUnitPrompt(brief({ locked_paths: [] }));
    expect(text).toContain("## Locked files (never modify)\n\nNone.");
  });
});

describe("role prompts", () => {
  for (const role of ROLES) {
    test(`${role} loads and tells the worker how to finish`, async () => {
      const text = await loadRolePrompt(role);
      expect(text).toContain("submit_result");
      expect(text).not.toContain(String.fromCharCode(0x2014));
    });
  }

  test("an unknown role is an error", async () => {
    await expect(loadRolePrompt("reviewer")).rejects.toThrow("no role prompt for reviewer");
  });
});
