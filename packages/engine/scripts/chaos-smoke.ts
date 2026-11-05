#!/usr/bin/env bun
// Real kills (SPEC section 13): a child process builds, stages and merges a run with a slow
// scripted worker; the parent SIGKILLs it at a random moment, resumes it in a fresh process,
// and checks the outcome against a run never killed.
//
//   bun packages/engine/scripts/chaos-smoke.ts [--runs 10] [--seed 1]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { type Brief, briefHash, type Plan, type Task, type Workspace } from "@hephaestus/core";
import { openLedger } from "@hephaestus/ledger";
import { openSandbox, runOk } from "@hephaestus/sandbox";
import { pendingEffects } from "../src/effects.ts";
import { buildRun, createRun, type RunPlanOptions, recordPlan } from "../src/engine.ts";
import { landChangeset, mergeChangeset } from "../src/land.ts";
import type { Worker } from "../src/worker.ts";

const WORKER_MS = 250;

function put(root: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
}

const brief: Brief = {
  schema: 1,
  goal: "loot drops reach the server",
  context: "",
  decisions: [],
  constraints: [],
  acceptance: [{ id: "AC1", text: "server handles LootDrop", kind: "behavior" }],
  out_of_scope: [],
  open_questions: [],
  source: "cli",
};
const task = (id: string, t: Partial<Task>): Task => ({
  id,
  title: id,
  kind: "implement",
  project: "server",
  lane: "contained",
  complexity: "standard",
  complexity_reason: "x",
  scope: [],
  covers: ["AC1"],
  spec: id,
  ...t,
});
const plan: Plan = {
  schema: 1,
  brief_hash: briefHash(brief),
  tasks: [
    task("P1", {
      project: "proto",
      kind: "codegen",
      covers: [],
      scope: ["loot.txt"],
      produces: ["proto:Loot"],
    }),
    task("S1", {
      kind: "test",
      scope: ["check.sh"],
      consumes: ["proto:Loot"],
      produces: ["test:Loot"],
    }),
    task("S2", { scope: ["impl.sh"], consumes: ["test:Loot"] }),
    task("S3", { scope: ["docs.txt"], consumes: ["test:Loot"] }),
  ],
  risks: [],
};
const FILES: Record<string, Record<string, string>> = {
  P1: { "loot.txt": "LootDrop\n" },
  S1: { "check.sh": "test -f impl.sh\n" },
  S2: { "impl.sh": "echo loot\n" },
  S3: { "docs.txt": "loot docs\n" },
};
const workspace: Workspace = {
  repos: { proto: "./proto", server: "./server", web: "./web" },
  projects: {
    proto: { repo: "proto", path: ".", stack: "schema" },
    server: { repo: "server", path: ".", stack: "sh", depends_on: ["proto"] },
    web: { repo: "web", path: ".", stack: "ts" },
  },
};

const slowWorker: Worker = {
  async spawn(input) {
    await Bun.sleep(WORKER_MS);
    const files = FILES[input.brief.task.id] ?? {};
    put(input.workdir, files);
    return {
      output: { schema: 1, summary: "", claims: [], touched: Object.keys(files) },
      transcript: "",
      usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
      exit: "ok",
    };
  },
};

function options(dir: string): RunPlanOptions & { node: string } {
  const node = join(dir, "node");
  return {
    node,
    ledger: openLedger(node, { nodeId: "smoke" }),
    workspace,
    workspaceRoot: join(dir, "ws"),
    brief,
    plan,
    runId: "R1",
    changesetId: "C1",
    worker: slowWorker,
    gates: [],
    config: {
      routing: {
        test_author: { default: { model: "claude/sonnet" } },
        implementer: { default: { model: "claude/sonnet" } },
      },
      maxAttempts: 3,
      parallel: 1,
      budgetTokens: 20_000,
      tools: [],
      commands: { server: { test: "sh check.sh" } },
    },
    worktreesDir: join(dir, "worktrees"),
    gateSandbox: (w) => openSandbox({ mode: "native", hostDir: w }),
    integrationSandbox: (d) => openSandbox({ mode: "native", hostDir: d }),
  };
}

async function scenario(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "heph-chaos-"));
  const fixtures: Record<string, Record<string, string>> = {
    proto: { "messages.txt": "base\n" },
    server: { "README.md": "server\n" },
    web: { "index.html": "web\n" },
  };
  for (const [name, files] of Object.entries(fixtures)) {
    const repo = join(dir, "ws", name);
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => runOk(["git", ...a], { cwd: repo });
    await git("init", "-q", "-b", "main");
    put(repo, files);
    await git("add", "-A");
    await git("-c", "user.name=T", "-c", "user.email=t@x", "commit", "-qm", "base");
  }
  const o = options(dir);
  createRun(o);
  recordPlan(o, plan);
  o.ledger.close();
  return dir;
}

/** The child: what heph run then heph approve merge do, from wherever the run is. */
async function child(dir: string) {
  const o = options(dir);
  const status = () => o.ledger.run("R1")?.status;
  const { brief: _b, plan: _p, ...rest } = o;
  if (["planned", "running", "paused"].includes(status() as string)) await buildRun(rest);
  if (status() === "built") await landChangeset(o);
  if (status() === "staged") await mergeChangeset(o);
  o.ledger.close();
}

async function outcome(dir: string) {
  const ledger = openLedger(join(dir, "node"), { nodeId: "smoke" });
  const repos: Record<string, unknown> = {};
  for (const r of Object.keys(workspace.repos)) {
    const cwd = join(dir, "ws", r);
    repos[r] = {
      tree: await runOk(["git", "ls-tree", "-r", "main"], { cwd }),
      commits: (await runOk(["git", "rev-list", "--count", "main"], { cwd })).trim(),
      worktrees: (await runOk(["git", "worktree", "list"], { cwd })).trim().split("\n").length,
    };
  }
  const events = ledger.read({ run_id: "R1" }).map((s) => s.event);
  const result = {
    status: ledger.run("R1")?.status,
    repos,
    accepted: events
      .filter((e) => e.type === "unit.accepted")
      .map((e) => e.unit_id)
      .sort(),
    greens: events
      .filter(
        (e) =>
          e.type === "unit.attempt.finished" && (e.data as { outcome: string }).outcome === "green",
      )
      .map((e) => e.unit_id)
      .sort(),
    pending: pendingEffects(ledger, "R1").length,
  };
  const interrupted = events.filter((e) => e.type === "unit.attempt.interrupted").length;
  ledger.close();
  return { result, interrupted };
}

const spawnChild = (dir: string) =>
  Bun.spawn(["bun", import.meta.path, "--child", dir], { stdout: "ignore", stderr: "pipe" });

async function finish(dir: string) {
  const p = spawnChild(dir);
  if ((await p.exited) !== 0)
    throw new Error(`resume failed: ${await new Response(p.stderr).text()}`);
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      child: { type: "string" },
      runs: { type: "string", default: "10" },
      seed: { type: "string", default: String(Date.now() % 100_000) },
    },
  });
  if (values.child) return child(values.child);

  let seed = Number(values.seed);
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };

  const base = await scenario();
  const t0 = Date.now();
  await finish(base);
  const took = Date.now() - t0;
  const expected = JSON.stringify((await outcome(base)).result);
  rmSync(base, { recursive: true, force: true });
  console.log(`baseline: ${took} ms, seed ${values.seed}`);

  let same = 0;
  const runs = Number(values.runs);
  for (let i = 1; i <= runs; i++) {
    const dir = await scenario();
    const at = Math.floor(random() * took);
    const p = spawnChild(dir);
    const timer = setTimeout(() => p.kill("SIGKILL"), at);
    const code = await p.exited;
    clearTimeout(timer);
    await finish(dir);
    const { result, interrupted } = await outcome(dir);
    const ok = JSON.stringify(result) === expected;
    if (ok) same++;
    console.log(
      `run ${i}: killed at ${at} ms (${code === 0 ? "finished before the kill" : `signal ${p.signalCode}`}), ${interrupted} attempt(s) interrupted, ${ok ? "same outcome" : "DIFFERENT"}`,
    );
    if (!ok)
      console.log(`  expected ${expected}\n  got      ${JSON.stringify(result)}\n  kept ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
  console.log(`${same} of ${runs} resumed runs ended like the baseline`);
  if (same !== runs) process.exit(1);
}

await main();
