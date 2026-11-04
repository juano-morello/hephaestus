import { describe, expect, test } from "bun:test";
import type { Task } from "@hephaestus/core";
import { openSandbox } from "@hephaestus/sandbox";
import {
  builtinGates,
  diffScopeGate,
  lintGate,
  lockedPathsGate,
  testsGate,
  touchedVsDiffGate,
  typecheckGate,
} from "../src/builtin-gates.ts";
import type { UnitGateContext } from "../src/gates.ts";
import { tempDir, writeFiles } from "./helpers.ts";

const dir = tempDir();

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "T2",
  title: "impl",
  kind: "implement",
  project: "server",
  lane: "contained",
  complexity: "standard",
  complexity_reason: "x",
  scope: ["inventory/*.go"],
  covers: ["AC1"],
  spec: "x",
  ...overrides,
});

const ctx = (overrides: Partial<UnitGateContext> = {}): UnitGateContext => ({
  task: task(),
  attempt: 1,
  project: "server",
  projectPath: "server",
  workdir: "/nowhere",
  diff: { files: ["server/inventory/stack.go"], text: "" },
  lockedPaths: [],
  worker: { schema: 1, summary: "", claims: [], touched: ["inventory/stack.go"] },
  commands: {},
  timeoutMs: 10_000,
  ...overrides,
});

describe("diff_scope", () => {
  test("passes when every change is in the project and in scope", () => {
    expect(diffScopeGate.run(ctx())).toMatchObject({
      gate: "diff_scope",
      verdict: "pass",
      evidence: [],
    });
  });

  test("flags files outside the project and outside the task scope", () => {
    const r = diffScopeGate.run(
      ctx({
        diff: { files: ["NOTICE", "server/inventory/stack.go", "server/net/session.go"], text: "" },
      }),
    );
    expect(r).toMatchObject({
      verdict: "fail",
      evidence: ["outside project: NOTICE", "out of scope: net/session.go"],
    });
  });

  test("a project at the repo root", () => {
    const r = diffScopeGate.run(
      ctx({ projectPath: ".", diff: { files: ["inventory/a.go", "README.md"], text: "" } }),
    );
    expect(r.evidence).toEqual(["out of scope: README.md"]);
  });
});

describe("locked_paths", () => {
  test("flags a modified locked file", () => {
    const pass = lockedPathsGate.run(ctx({ lockedPaths: ["inventory/stack_test.go"] }));
    expect(pass.verdict).toBe("pass");
    const fail = lockedPathsGate.run(
      ctx({
        lockedPaths: ["inventory/stack_test.go"],
        diff: { files: ["server/inventory/stack_test.go"], text: "" },
      }),
    );
    expect(fail).toMatchObject({
      verdict: "fail",
      evidence: ["modified locked file: inventory/stack_test.go"],
    });
  });
});

describe("touched_vs_diff", () => {
  test("passes when touched equals the diff, ignoring ./ and order", () => {
    const r = touchedVsDiffGate.run(
      ctx({
        diff: { files: ["server/inventory/a.go", "server/inventory/b.go"], text: "" },
        worker: {
          schema: 1,
          summary: "",
          claims: [],
          touched: ["./inventory/b.go", "inventory/a.go"],
        },
      }),
    );
    expect(r.verdict).toBe("pass");
  });

  test("reports both directions of a mismatch", () => {
    const r = touchedVsDiffGate.run(
      ctx({
        diff: { files: ["server/inventory/a.go", "NOTICE"], text: "" },
        worker: { schema: 1, summary: "", claims: [], touched: ["inventory/b.go"] },
      }),
    );
    expect(r).toMatchObject({
      verdict: "fail",
      evidence: [
        "changed but not in touched: inventory/a.go",
        "changed but not in touched: NOTICE",
        "in touched but unchanged: inventory/b.go",
      ],
    });
  });
});

async function withSandbox(files: Record<string, string>, overrides: Partial<UnitGateContext>) {
  const root = dir();
  writeFiles(root, files);
  const sandbox = await openSandbox({ mode: "native", hostDir: root });
  return ctx({ workdir: root, sandbox, ...overrides });
}

const pass = { "t.sh": "exit 0\n" };
const fail = { "t.sh": 'echo "FAIL: AC1 wanted 5 got 6"\nexit 1\n' };

describe("tests", () => {
  test("must pass after an implement unit and fail after a test unit", async () => {
    const commands = { test: "sh t.sh" };
    expect(await testsGate.run(await withSandbox(pass, { commands }))).toMatchObject({
      verdict: "pass",
    });
    expect(await testsGate.run(await withSandbox(fail, { commands }))).toMatchObject({
      verdict: "fail",
      reason: "tests must pass here",
      evidence: ["exit 1", "FAIL: AC1 wanted 5 got 6"],
    });
    const t = task({ kind: "test" });
    expect(await testsGate.run(await withSandbox(fail, { commands, task: t }))).toMatchObject({
      verdict: "pass",
      reason: "tests fail, as a test unit requires (red before green)",
    });
    expect(await testsGate.run(await withSandbox(pass, { commands, task: t }))).toMatchObject({
      verdict: "fail",
      reason: "tests must fail after a test unit (red before green)",
    });
  });

  test("fails without a test command or a sandbox", async () => {
    expect(await testsGate.run(await withSandbox(pass, {}))).toMatchObject({
      verdict: "fail",
      reason: "no test command configured",
    });
    expect(await testsGate.run(ctx({ commands: { test: "sh t.sh" } }))).toMatchObject({
      verdict: "fail",
      reason: "no sandbox configured for gates",
    });
  });

  test("evidence is the tail of the output", async () => {
    const lots = {
      "t.sh": 'i=0; while [ $i -lt 200 ]; do echo "line $i"; i=$((i+1)); done; exit 1\n',
    };
    const r = await testsGate.run(await withSandbox(lots, { commands: { test: "sh t.sh" } }));
    expect(r.evidence[0]).toBe("exit 1");
    const tail = r.evidence[1] as string;
    expect(tail.split("\n")).toHaveLength(60);
    expect(tail.endsWith("line 199")).toBe(true);
  });

  test("a command past the timeout fails the gate", async () => {
    const r = await testsGate.run(
      await withSandbox({}, { commands: { test: "sleep 5; true" }, timeoutMs: 200 }),
    );
    expect(r).toMatchObject({ verdict: "fail", reason: "timed out after 200 ms" });
  });
});

describe("typecheck and lint", () => {
  test("pass, saying so, when no command is configured", async () => {
    expect(await lintGate.run(await withSandbox({}, {}))).toMatchObject({
      gate: "lint",
      verdict: "pass",
      reason: "skipped: no lint command configured",
    });
  });

  test("are skipped for test units and enforced otherwise", async () => {
    const commands = { typecheck: "sh t.sh" };
    expect(
      await typecheckGate.run(await withSandbox(fail, { commands, task: task({ kind: "test" }) })),
    ).toMatchObject({
      verdict: "pass",
      reason: "skipped for test units",
    });
    expect(await typecheckGate.run(await withSandbox(fail, { commands }))).toMatchObject({
      verdict: "fail",
      reason: "typecheck failed",
    });
    expect(await typecheckGate.run(await withSandbox(pass, { commands }))).toMatchObject({
      verdict: "pass",
    });
  });
});

describe("builtinGates", () => {
  test("cheap diff gates first, command gates marked as needing a sandbox", () => {
    const gates = builtinGates();
    expect(gates.map((g) => g.name)).toEqual([
      "diff_scope",
      "locked_paths",
      "touched_vs_diff",
      "tests",
      "typecheck",
      "lint",
    ]);
    expect(gates.map((g) => g.needsSandbox ?? false)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  });
});

describe("rough edges", () => {
  test("a modified locked file is reported by locked_paths only", () => {
    const c = ctx({
      task: task({ scope: ["inventory/stack.go"] }),
      lockedPaths: ["inventory/stack_test.go"],
      diff: { files: ["server/inventory/stack.go", "server/inventory/stack_test.go"], text: "" },
    });
    expect(diffScopeGate.run(c)).toMatchObject({ verdict: "pass" });
    expect(lockedPathsGate.run(c)).toMatchObject({
      verdict: "fail",
      evidence: ["modified locked file: inventory/stack_test.go"],
    });
  });

  const lint = {
    "lint.sh": 'for f in "$@"; do case "$f" in *bad*) echo "lint: $f"; exit 1;; esac; done\n',
  };

  test("{files} runs lint on the changed project files, for test units too", async () => {
    const t = task({ kind: "test" });
    const changed = (files: string[]) => ({ files: files.map((f) => `server/${f}`), text: "" });
    const clean = await withSandbox(lint, {
      task: t,
      commands: { lint: "sh lint.sh {files}" },
      diff: changed(["inventory/a_test.go"]),
    });
    expect(await lintGate.run(clean)).toMatchObject({ verdict: "pass", reason: "lint passed" });
    const dirty = await withSandbox(lint, {
      task: t,
      commands: { lint: "sh lint.sh {files}" },
      diff: changed(["inventory/ok_test.go", "inventory/bad name_test.go"]),
    });
    expect(await lintGate.run(dirty)).toMatchObject({
      verdict: "fail",
      evidence: ["exit 1", "lint: inventory/bad name_test.go"],
    });
  });

  test("{files} with nothing changed in the project is skipped; without {files} test units still skip", async () => {
    const none = await withSandbox(lint, {
      commands: { lint: "sh lint.sh {files}" },
      diff: { files: ["NOTICE"], text: "" },
    });
    expect(await lintGate.run(none)).toMatchObject({
      verdict: "pass",
      reason: "skipped: no changed files in the project",
    });
    const plain = await withSandbox(lint, {
      task: task({ kind: "test" }),
      commands: { typecheck: "sh lint.sh" },
    });
    expect(await typecheckGate.run(plain)).toMatchObject({
      verdict: "pass",
      reason: "skipped for test units",
    });
  });
});
