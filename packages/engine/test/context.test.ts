import { describe, expect, test } from "bun:test";
import type { Return, Task } from "@hephaestus/core";
import { buildContextPack } from "../src/context.ts";
import { createGit } from "../src/git.ts";
import { initRepo, tempDir } from "./helpers.ts";

const dir = tempDir();

const task = (scope: string[]): Task => ({
  id: "T2",
  title: "impl",
  kind: "implement",
  project: "server",
  lane: "contained",
  complexity: "standard",
  complexity_reason: "x",
  scope,
  covers: ["AC1"],
  spec: "do it",
});

const repo = () =>
  initRepo(dir(), {
    "server/inventory/stack.go": "package inventory\n",
    "server/inventory/stack_test.go": "package inventory // locked\n",
    "server/inventory/cap.go": "package inventory // cap\n",
    "server/net/session.go": "package net\n",
    "client/main.gd": "extends Node\n",
  });

const project = { name: "server", stack: "go", commands: { test: "go test ./..." } };

describe("buildContextPack", () => {
  test("includes scope files of the project in full, with project-relative paths", async () => {
    const root = await repo();
    const { pack } = await buildContextPack({
      git: createGit(root),
      worktree: root,
      projectPath: "server",
      project,
      task: task(["inventory/*.go"]),
      locked: [],
      constraints: ["no locks"],
      budgetTokens: 10_000,
    });
    expect(pack.files).toEqual([
      { path: "inventory/cap.go", content: "package inventory // cap\n", why: "scope" },
      { path: "inventory/stack.go", content: "package inventory\n", why: "scope" },
      { path: "inventory/stack_test.go", content: "package inventory // locked\n", why: "scope" },
    ]);
    expect(pack).toMatchObject({
      schema: 1,
      project,
      constraints: ["no locks"],
      budget_tokens: 10_000,
    });
  });

  test("locked files go in full to `locked` and are not repeated in `files`", async () => {
    const root = await repo();
    const { pack } = await buildContextPack({
      git: createGit(root),
      worktree: root,
      projectPath: "server",
      project,
      task: task(["inventory/*.go"]),
      locked: ["inventory/stack_test.go"],
      constraints: [],
      budgetTokens: 10_000,
    });
    expect(pack.locked).toEqual([
      { path: "inventory/stack_test.go", content: "package inventory // locked\n" },
    ]);
    expect(pack.files.map((f) => f.path)).toEqual(["inventory/cap.go", "inventory/stack.go"]);
  });

  test("a project at the repo root and a scope with new files work", async () => {
    const root = await initRepo(dir(), { "a.go": "package a\n" });
    const { pack } = await buildContextPack({
      git: createGit(root),
      worktree: root,
      projectPath: ".",
      project,
      task: task(["a.go", "b_new.go"]),
      locked: [],
      constraints: [],
      budgetTokens: 10_000,
    });
    expect(pack.files.map((f) => f.path)).toEqual(["a.go"]);
  });

  test("feedback rides along", async () => {
    const root = await repo();
    const feedback: Return = {
      schema: 1,
      unit_id: "T2",
      attempt: 1,
      verdict: "red",
      reasons: [{ gate: "tests", reason: "failed", evidence: "x" }],
      scope: ["inventory/stack.go"],
      instruction: "fix only the listed failures; do not modify locked paths",
    };
    const { pack } = await buildContextPack({
      git: createGit(root),
      worktree: root,
      projectPath: "server",
      project,
      task: task(["inventory/stack.go"]),
      locked: [],
      constraints: [],
      feedback,
      budgetTokens: 10_000,
    });
    expect(pack.feedback).toEqual(feedback);
  });

  test("over budget: locked stays, scope files are dropped and recorded as truncated", async () => {
    const root = await repo();
    const { pack, truncated, sizeTokens } = await buildContextPack({
      git: createGit(root),
      worktree: root,
      projectPath: "server",
      project,
      task: task(["inventory/*.go"]),
      locked: ["inventory/stack_test.go"],
      constraints: [],
      budgetTokens: 12,
    });
    expect(pack.locked).toHaveLength(1);
    expect(pack.files.map((f) => f.path)).toEqual(["inventory/cap.go"]);
    expect(truncated).toEqual(["inventory/stack.go"]);
    expect(sizeTokens).toBeGreaterThan(0);
  });
});
