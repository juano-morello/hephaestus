import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Brief, GateResult, Plan, Task, Workspace } from "@hephaestus/core";
import { briefHash } from "@hephaestus/core";
import { openLedger } from "@hephaestus/ledger";
import { runOk } from "@hephaestus/sandbox";
import type { EngineConfig } from "../src/config.ts";
import { attemptBranch, runBranch, runPlan } from "../src/engine.ts";
import type { UnitGate, UnitGateContext } from "../src/gates.ts";
import { createGit } from "../src/git.ts";
import type { SpawnInput, SpawnOutput, Worker } from "../src/worker.ts";
import { initRepo, tempDir, writeFiles } from "./helpers.ts";

const dir = tempDir();

const brief: Brief = {
  schema: 1,
  goal: "stacks cap at max_stack",
  context: "",
  decisions: [],
  constraints: ["no locks"],
  acceptance: [{ id: "AC1", text: "cap", kind: "behavior" }],
  out_of_scope: [],
  open_questions: [],
  source: "cli",
};

const workspace: Workspace = {
  repos: { game: "." },
  projects: { server: { repo: "game", path: "server", stack: "go" } },
};

const task = (id: string, overrides: Partial<Task>): Task => ({
  id,
  title: id,
  kind: "implement",
  project: "server",
  lane: "contained",
  complexity: "standard",
  complexity_reason: "x",
  scope: [],
  covers: ["AC1"],
  spec: `do ${id}`,
  ...overrides,
});

const plan = (tasks?: Task[]): Plan => ({
  schema: 1,
  brief_hash: briefHash(brief),
  // Listed implement-first on purpose: the engine must order by derived edges, not plan order.
  tasks: tasks ?? [
    task("T2", { scope: ["inventory/stack.go"], consumes: ["test:Cap"] }),
    task("T1", { kind: "test", scope: ["inventory/*_test.go"], produces: ["test:Cap"] }),
  ],
  risks: [],
});

const config: EngineConfig = {
  routing: {
    test_author: { default: { model: "claude/sonnet", effort: "medium" } },
    implementer: { standard: { model: "claude/sonnet" }, default: { model: "claude/haiku" } },
  },
  maxAttempts: 3,
  budgetTokens: 20_000,
  tools: ["read", "edit", "bash"],
  commands: { server: { test: "go test ./..." } },
};

const usage = { input: 100, output: 50, cache_read: 0, cache_write: 0 };

type Step = {
  files?: Record<string, string>;
  output?: unknown;
  exit?: SpawnOutput["exit"];
};

/** Plays a scripted step per call for each unit and records what it was given. */
function fakeWorker(script: Record<string, Step[]>) {
  const calls: { input: SpawnInput; present: string[] }[] = [];
  const worker: Worker = {
    async spawn(input) {
      const id = input.brief.task.id;
      const n = calls.filter((c) => c.input.brief.task.id === id).length;
      const step = script[id]?.[n] ?? {};
      calls.push({
        input,
        present: (await runOk(["git", "ls-files"], { cwd: input.workdir }))
          .split("\n")
          .filter(Boolean),
      });
      writeFiles(input.workdir, step.files ?? {});
      const touched = Object.keys(step.files ?? {});
      return {
        output: step.output ?? { schema: 1, summary: `did ${id}`, claims: [], touched },
        transcript: `transcript ${id} #${n + 1}`,
        usage,
        exit: step.exit ?? "ok",
        prompt_hash: "p1",
      };
    },
  };
  return { worker, calls };
}

/** Passes when every listed file in the attempt's worktree contains the text. */
const contains = (name: string, path: string, text: string): UnitGate => ({
  name,
  run: (ctx): GateResult => {
    const full = join(ctx.workdir, path);
    const ok = existsSync(full) && readFileSync(full, "utf8").includes(text);
    return {
      gate: name,
      verdict: ok ? "pass" : "fail",
      reason: ok ? "ok" : `${path} lacks ${text}`,
      evidence: ok ? [] : [`${path}: missing "${text}"`],
    };
  },
});

const onlyFor = (unit: string, gate: UnitGate): UnitGate => ({
  name: gate.name,
  run: (ctx) =>
    ctx.task.id === unit
      ? gate.run(ctx)
      : { gate: gate.name, verdict: "pass", reason: "n/a", evidence: [] },
});

async function setup() {
  const repoDir = await initRepo(dir(), {
    "server/go.mod": "module game\n",
    "server/inventory/stack.go": "package inventory\n",
  });
  const ledger = openLedger(join(dir(), "node"), { nodeId: "devserver" });
  const worktreesDir = join(dir(), "worktrees");
  const go = (worker: Worker, gates: UnitGate[] = [], p = plan()) =>
    runPlan({
      ledger,
      workspace,
      repoDir,
      baseRef: "main",
      brief,
      plan: p,
      runId: "R1",
      changesetId: "C1",
      worker,
      gates,
      config,
      worktreesDir,
    });
  const types = () => ledger.read().map((s) => s.event.type);
  return { repoDir, ledger, worktreesDir, go, types, git: createGit(repoDir) };
}

const testFile = { "inventory/stack_test.go": "package inventory // TestCap\n" };
const implFile = (v: string) => ({ "inventory/stack.go": `package inventory // ${v}\n` });

describe("runPlan", () => {
  test("happy path: tests first, implement sees them locked, both land on the run branch", async () => {
    const { go, ledger, git, repoDir, types } = await setup();
    const { worker, calls } = fakeWorker({
      T1: [{ files: testFile }],
      T2: [{ files: implFile("capped") }],
    });
    const result = await go(worker, [
      onlyFor("T2", contains("impl", "inventory/stack.go", "capped")),
    ]);

    expect(result).toMatchObject({ status: "finished", runBranch: "heph/R1" });
    expect(calls.map((c) => c.input.brief.task.id)).toEqual(["T1", "T2"]);
    const t2 = calls[1];
    expect(t2?.present).toContain("inventory/stack_test.go");
    expect(t2?.input.brief.locked_paths).toEqual(["inventory/stack_test.go"]);
    expect(t2?.input.brief.context.locked).toEqual([
      { path: "inventory/stack_test.go", content: testFile["inventory/stack_test.go"] },
    ]);
    expect(t2?.input).toMatchObject({
      role: "implementer",
      model: "claude/sonnet",
      tools: config.tools,
    });
    expect(calls[0]?.input).toMatchObject({
      role: "test_author",
      model: "claude/sonnet",
      effort: "medium",
    });
    expect(t2?.input.workdir.endsWith(join("R1", "T2", "a1", "server"))).toBe(true);

    const sha = await git.revParse("heph/R1");
    expect(result.runBranchSha).toBe(sha);
    expect((await git.diff("main", sha)).files).toEqual([
      "server/inventory/stack.go",
      "server/inventory/stack_test.go",
    ]);
    expect(await runOk(["git", "log", "--format=%s", "main..heph/R1"], { cwd: repoDir })).toBe(
      "heph: R1 T2 a1\nheph: R1 T1 a1\n",
    );

    expect(types()).toEqual([
      "run.created",
      "run.plan_ready",
      "node.started",
      "context.pack_built",
      "unit.attempt.started",
      "gate.result",
      "unit.attempt.finished",
      "unit.accepted",
      "context.pack_built",
      "unit.attempt.started",
      "gate.result",
      "unit.attempt.finished",
      "unit.accepted",
      "node.finished",
      "run.finished",
    ]);
    expect(ledger.run("R1")).toMatchObject({
      status: "finished",
      brief_hash: briefHash(brief),
      eval: false,
    });
    expect(ledger.units("R1").map((u) => [u.unit_id, u.status, u.attempts])).toEqual([
      ["T1", "accepted", 1],
      ["T2", "accepted", 1],
    ]);
    ledger.close();
  });

  test("red then green: the Return reaches the next attempt as feedback", async () => {
    const { go, ledger } = await setup();
    const { worker, calls } = fakeWorker({
      T1: [{ files: testFile }],
      T2: [{ files: implFile("wip") }, { files: implFile("capped") }],
    });
    const result = await go(worker, [
      onlyFor("T2", contains("impl", "inventory/stack.go", "capped")),
    ]);

    expect(result.status).toBe("finished");
    const second = calls.filter((c) => c.input.brief.task.id === "T2")[1];
    expect(second?.input.brief.feedback).toEqual({
      schema: 1,
      unit_id: "T2",
      attempt: 1,
      verdict: "red",
      reasons: [
        {
          gate: "impl",
          reason: "inventory/stack.go lacks capped",
          evidence: 'inventory/stack.go: missing "capped"',
        },
      ],
      scope: ["inventory/stack.go"],
      instruction: "fix only the listed failures; do not modify locked paths",
    });
    expect(second?.input.brief.context.feedback).toEqual(second?.input.brief.feedback);
    expect(ledger.units("R1").find((u) => u.unit_id === "T2")).toMatchObject({
      status: "accepted",
      attempts: 2,
    });
    expect(ledger.attempts("R1", "T2").map((a) => a.outcome)).toEqual(["red", "green"]);
    ledger.close();
  });

  test("three reds: unit escalated, run paused, later units never start, run branch untouched", async () => {
    const p = plan([
      task("T1", { scope: ["inventory/stack.go"], produces: ["fn:A"] }),
      task("T3", { scope: ["inventory/other.go"], consumes: ["fn:A"] }),
    ]);
    const { go, ledger, git } = await setup();
    const { worker, calls } = fakeWorker({
      T1: [{ files: implFile("a") }, { files: implFile("b") }, { files: implFile("c") }],
    });
    const result = await go(worker, [contains("impl", "inventory/stack.go", "capped")], p);

    expect(result).toMatchObject({ status: "paused", reason: "T1: red after 3 attempts" });
    expect(calls.map((c) => c.input.brief.task.id)).toEqual(["T1", "T1", "T1"]);
    expect(await git.revParse("heph/R1")).toBe(await git.revParse("main"));
    expect(ledger.run("R1")?.status).toBe("paused");
    expect(ledger.units("R1").map((u) => [u.unit_id, u.status, u.attempts])).toEqual([
      ["T1", "escalated", 3],
      ["T3", "pending", 0],
    ]);
    const last = ledger.read({ types: ["unit.escalated", "run.paused"] }).map((s) => s.event.data);
    expect(last).toEqual([{ reason: "red after 3 attempts" }, { reason: "user" }]);
    ledger.close();
  });

  test("blocked: honest exit escalates at once, no more attempts", async () => {
    const { go, ledger } = await setup();
    const { worker, calls } = fakeWorker({
      T1: [{ files: testFile }],
      T2: [
        {
          output: {
            schema: 1,
            summary: "",
            claims: [],
            touched: [],
            blocked: { reason: "AC1 test expects 51, spec says 50" },
          },
        },
      ],
    });
    const result = await go(worker);

    expect(result).toMatchObject({
      status: "paused",
      reason: "T2: blocked: AC1 test expects 51, spec says 50",
    });
    expect(calls).toHaveLength(2);
    expect(ledger.attempts("R1", "T2").map((a) => a.outcome)).toEqual(["blocked"]);
    expect(ledger.units("R1").find((u) => u.unit_id === "T2")?.status).toBe("escalated");
    ledger.close();
  });

  test("rate limited: the attempt is interrupted, not counted, and the run pauses", async () => {
    const { go, ledger, types } = await setup();
    const { worker } = fakeWorker({ T1: [{ exit: "rate_limited" }] });
    const result = await go(worker);

    expect(result).toMatchObject({ status: "paused", reason: "T1: rate_limit" });
    expect(types().slice(-3)).toEqual([
      "unit.attempt.started",
      "unit.attempt.interrupted",
      "run.paused",
    ]);
    expect(ledger.run("R1")?.status).toBe("paused");
    expect(ledger.units("R1").find((u) => u.unit_id === "T1")).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    expect(ledger.read({ types: ["run.paused"] })[0]?.event.data).toEqual({ reason: "rate_limit" });
    ledger.close();
  });

  test("invalid worker output counts as an errored attempt with a worker_output reason", async () => {
    const { go, ledger } = await setup();
    const { worker, calls } = fakeWorker({
      T1: [{ output: { done: true } }, { files: testFile }],
      T2: [{ files: implFile("capped") }],
    });
    const result = await go(worker);

    expect(result.status).toBe("finished");
    expect(ledger.attempts("R1", "T1").map((a) => a.outcome)).toEqual(["error", "green"]);
    const feedback = calls[1]?.input.brief.feedback;
    expect(feedback?.reasons[0]).toMatchObject({
      gate: "worker_output",
      reason: "worker output does not match WorkerResult",
    });
    ledger.close();
  });

  test("the diff is the truth: gates see what was written, not what was claimed", async () => {
    const { go, ledger } = await setup();
    const seen: UnitGateContext[] = [];
    const spy: UnitGate = {
      name: "spy",
      run: (ctx) => {
        seen.push(ctx);
        return { gate: "spy", verdict: "pass", reason: "ok", evidence: [] };
      },
    };
    const { worker } = fakeWorker({
      T1: [
        {
          files: { "inventory/sneaky_test.go": "x" },
          output: { schema: 1, summary: "", claims: [], touched: ["inventory/stack_test.go"] },
        },
      ],
      T2: [{ files: implFile("capped") }],
    });
    await go(worker, [spy]);

    expect(seen[0]?.diff.files).toEqual(["server/inventory/sneaky_test.go"]);
    expect(seen[0]?.worker.touched).toEqual(["inventory/stack_test.go"]);
    expect(seen[1]?.lockedPaths).toEqual(["inventory/sneaky_test.go"]);
    const finished = ledger.read({ types: ["unit.attempt.finished"] })[0]?.event;
    expect(ledger.blobs.getText(finished?.blobs?.diff as string)).toContain("sneaky_test.go");
    expect(ledger.blobs.getText(finished?.blobs?.transcript as string)).toBe("transcript T1 #1");
    ledger.close();
  });

  test("deterministic branches stay, worktrees go", async () => {
    const { go, git, worktreesDir, ledger } = await setup();
    const { worker } = fakeWorker({
      T1: [{ files: testFile }],
      T2: [{ files: implFile("wip") }, { files: implFile("capped") }],
    });
    await go(worker, [onlyFor("T2", contains("impl", "inventory/stack.go", "capped"))]);

    expect(runBranch("R1")).toBe("heph/R1");
    expect(attemptBranch("R1", "T2", 2)).toBe("heph-attempt/R1/T2/a2");
    for (const b of ["heph-attempt/R1/T1/a1", "heph-attempt/R1/T2/a1", "heph-attempt/R1/T2/a2"]) {
      expect(await git.revParse(b)).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(await git.revParse("heph/R1")).toBe(await git.revParse("heph-attempt/R1/T2/a2"));
    const left = existsSync(worktreesDir) ? readdirSync(join(worktreesDir, "R1", "T2")) : [];
    expect(left).toEqual([]);
    ledger.close();
  });

  test("rejects a plan that spans two repos", async () => {
    const { ledger } = await setup();
    const ws: Workspace = {
      repos: { game: ".", proto: "../proto" },
      projects: {
        server: { repo: "game", path: "server", stack: "go" },
        proto: { repo: "proto", path: ".", stack: "schema" },
      },
    };
    const p = plan([
      task("T1", { scope: ["a.go"] }),
      task("P1", { project: "proto", kind: "codegen", covers: [], scope: ["x.proto"] }),
    ]);
    await expect(
      runPlan({
        ledger,
        workspace: ws,
        repoDir: dir(),
        baseRef: "main",
        brief,
        plan: p,
        runId: "R1",
        changesetId: "C1",
        worker: fakeWorker({}).worker,
        gates: [],
        config,
        worktreesDir: dir(),
      }),
    ).rejects.toThrow("multi-repo changesets are v0 step 2.5");
    expect(ledger.read()).toEqual([]);
    ledger.close();
  });

  test("rejects a plan for a different brief", async () => {
    const { go, ledger } = await setup();
    await expect(go(fakeWorker({}).worker, [], { ...plan(), brief_hash: "other" })).rejects.toThrow(
      "plan brief_hash does not match the brief",
    );
    ledger.close();
  });
});
