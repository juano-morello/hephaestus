import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Brief, Plan, Task, Workspace } from "@hephaestus/core";
import { briefHash } from "@hephaestus/core";
import { openLedger } from "@hephaestus/ledger";
import type { EngineConfig } from "../src/config.ts";
import { runPlan } from "../src/engine.ts";
import type { SpawnInput, SpawnOutput, Worker } from "../src/worker.ts";
import { initRepo, tempDir } from "./helpers.ts";

const dir = tempDir();

const brief: Brief = {
  schema: 1,
  goal: "g",
  context: "",
  decisions: [],
  constraints: [],
  acceptance: [{ id: "AC1", text: "x", kind: "behavior" }],
  out_of_scope: [],
  open_questions: [],
  source: "cli",
};
const workspace: Workspace = {
  repos: { game: "." },
  projects: { server: { repo: "game", path: "server", stack: "go" } },
};
const task: Task = {
  id: "T1",
  title: "T1",
  kind: "implement",
  project: "server",
  lane: "contained",
  complexity: "standard",
  complexity_reason: "x",
  scope: ["a.go"],
  covers: ["AC1"],
  spec: "do T1",
};
const plan: Plan = { schema: 1, brief_hash: briefHash(brief), tasks: [task], risks: [] };
const config: EngineConfig = {
  routing: { implementer: { default: { model: "claude/sonnet" } } },
  maxAttempts: 3,
  parallel: 1,
  budgetTokens: 20_000,
  tools: [],
  commands: {},
};

const usage = { input: 100, output: 50, cache_read: 10, cache_write: 5 };
const good = { schema: 1, summary: "did", claims: [], touched: [] };
const hung = (kind = "timeout", detail = "no response for 20 min"): SpawnOutput => ({
  output: undefined,
  transcript: "[]",
  usage,
  exit: "error",
  failure: { kind, detail },
});
const ok = (...args: [] | [unknown]): SpawnOutput => ({
  output: args.length ? args[0] : good,
  transcript: "[]",
  usage,
  exit: "ok",
});

async function run(steps: SpawnOutput[], extra: Partial<EngineConfig> = {}) {
  const repoDir = await initRepo(dir(), { "server/go.mod": "module game\n" });
  const ledger = openLedger(join(dir(), "node"), { nodeId: "n" });
  const calls: SpawnInput[] = [];
  const worker: Worker = {
    async spawn(input) {
      calls.push(input);
      const step = steps[calls.length - 1] ?? steps[steps.length - 1];
      if (!step) throw new Error("no step");
      return step;
    },
  };
  const result = await runPlan({
    ledger,
    workspace,
    workspaceRoot: repoDir,
    brief,
    plan,
    runId: "R1",
    changesetId: "C1",
    worker,
    gates: [],
    config: { ...config, ...extra },
    worktreesDir: join(dir(), "worktrees"),
  });
  return { result, ledger, calls };
}

describe("transport failures", () => {
  test("an empty result from a failed worker is retried without using an attempt", async () => {
    const { result, ledger, calls } = await run([hung(), ok()]);
    expect(result.status).toBe("built");
    expect(calls).toHaveLength(2);
    const attempts = ledger.attempts("R1", "T1");
    expect(attempts.map((a) => [a.attempt, a.outcome])).toEqual([[1, "green"]]);
    ledger.close();
  });

  test("a worker that throws is a transport failure too", async () => {
    const repoDir = await initRepo(dir(), { "server/go.mod": "module game\n" });
    const ledger = openLedger(join(dir(), "node"), { nodeId: "n" });
    let n = 0;
    const worker: Worker = {
      async spawn() {
        if (++n === 1) throw new Error("socket hang up");
        return ok();
      },
    };
    const result = await runPlan({
      ledger,
      workspace,
      workspaceRoot: repoDir,
      brief,
      plan,
      runId: "R1",
      changesetId: "C1",
      worker,
      gates: [],
      config,
      worktreesDir: join(dir(), "worktrees"),
    });
    expect(result.status).toBe("built");
    expect(n).toBe(2);
    ledger.close();
  });

  test("retries are capped, then the attempt is recorded as an error that says why", async () => {
    const { ledger, calls } = await run([hung("timeout", "no model output for 20 min")], {
      transportRetries: 2,
      maxAttempts: 1,
    });
    expect(calls).toHaveLength(3);
    const [a] = ledger.attempts("R1", "T1");
    expect(a?.outcome).toBe("error");
    const gate = ledger
      .read({ types: ["gate.result"] })
      .map((s) => s.event.data as { gate: string; reason: string; evidence: string[] })
      .find((g) => g.gate === "worker_output");
    expect(gate?.reason).toBe("worker transport failure: timeout");
    expect(gate?.evidence).toContain("detail: no model output for 20 min");
    expect(gate?.evidence.join("\n")).toContain("3 spawns");
    ledger.close();
  });

  test("usage of every spawn is paid for and summed", async () => {
    const { ledger } = await run([hung(), hung(), ok()]);
    expect(ledger.attempts("R1", "T1")[0]).toMatchObject({ input: 300, output: 150 });
    ledger.close();
  });

  test("an ok exit with no result is the model's failure, not transport: no retry", async () => {
    const { calls, ledger } = await run([ok(undefined)], { maxAttempts: 1 });
    expect(calls).toHaveLength(1);
    expect(ledger.attempts("R1", "T1")[0]?.outcome).toBe("error");
    ledger.close();
  });

  test("zero retries turns the retry off", async () => {
    const { calls, ledger } = await run([hung()], { transportRetries: 0, maxAttempts: 1 });
    expect(calls).toHaveLength(1);
    ledger.close();
  });

  test("two attempts that both hung stall with the reason in the message", async () => {
    const { result, ledger, calls } = await run([hung("idle", "no activity for 10 min")], {
      transportRetries: 1,
    });
    expect(calls).toHaveLength(4);
    expect(result).toMatchObject({ status: "paused" });
    expect(JSON.stringify(result)).toContain("no activity for 10 min");
    expect(ledger.read({ types: ["unit.stalled"] })).toHaveLength(1);
    ledger.close();
  });

  test("the attempt's timeouts reach the worker, by tier", async () => {
    // No matched files and one criterion: the router starts the task at trivial.
    const { calls } = await run([ok()], {
      attemptTimeoutMs: 1000,
      idleTimeoutMs: 500,
      attemptTimeoutByTier: { trivial: 5000 },
    });
    expect(calls[0]).toMatchObject({ timeoutMs: 5000, idleTimeoutMs: 500 });
    const other = await run([ok()], {
      attemptTimeoutMs: 1000,
      attemptTimeoutByTier: { complex: 9 },
    });
    expect(other.calls[0]?.timeoutMs).toBe(1000);
  });
});
