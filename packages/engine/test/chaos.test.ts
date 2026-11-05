import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { briefHash, type Plan, type Task } from "@hephaestus/core";
import { type EventDraft, type Ledger, type LedgerEvent, openLedger } from "@hephaestus/ledger";
import { openSandbox, runOk } from "@hephaestus/sandbox";
import { pendingEffects, Stopped } from "../src/effects.ts";
import { buildRun, createRun, type RunPlanOptions, recordPlan } from "../src/engine.ts";
import type { UnitGate } from "../src/gates.ts";
import { landChangeset, mergeChangeset } from "../src/land.ts";
import { localRunner, type Runner } from "../src/runner.ts";
import type { Worker } from "../src/worker.ts";
import { tempDir, writeFiles } from "./helpers.ts";
import { brief, config, crossRepoPlan, threeRepos, writer } from "./workspace.ts";

/**
 * SPEC section 13: kill the run at every point where the engine writes to the ledger or touches
 * git, resume it in a new process, and require the same outcome as a run never interrupted.
 */
const dir = tempDir();

/** Counts crash points; at point `at`, stops the run (after the ledger write commits). */
function killer(at: number) {
  let n = 0;
  let dead = false;
  const hit = () => {
    if (dead) throw new Stopped("already dead");
    if (n++ === at) {
      dead = true;
      throw new Stopped(`killed at point ${at}`);
    }
  };
  const wrap = (ledger: Ledger): Ledger => {
    const appendMany = (drafts: EventDraft[]): LedgerEvent[] => {
      if (dead) throw new Stopped("already dead");
      const out = ledger.appendMany(drafts);
      hit();
      return out;
    };
    return {
      ...ledger,
      appendMany,
      append: ((d: EventDraft) => appendMany([d])[0]) as Ledger["append"],
    };
  };
  return { wrap, chaos: (_p: string) => hit(), count: () => n, dead: () => dead };
}

type Shape = { plan: Plan; commands: Record<string, Record<string, string>>; parallel: number };

const serial: Shape = {
  plan: crossRepoPlan(),
  commands: { server: { test: "sh check.sh" } },
  parallel: 1,
};

async function scenario(shape: Shape = serial) {
  const { root, workspace } = await threeRepos(dir());
  const node = join(dir(), "node");
  const ledger = openLedger(node, { nodeId: "devserver" });
  const options: RunPlanOptions = {
    ledger,
    workspace,
    workspaceRoot: root,
    brief,
    plan: shape.plan,
    runId: "R1",
    changesetId: "C1",
    worker: writer,
    gates: [],
    config: { ...config, parallel: shape.parallel, commands: shape.commands },
    worktreesDir: join(dir(), "worktrees"),
    gateSandbox: (w) => openSandbox({ mode: "native", hostDir: w }),
    integrationSandbox: (d) => openSandbox({ mode: "native", hostDir: d }),
  };
  createRun(options);
  recordPlan(options, options.plan);
  ledger.close();
  const { plan, ...rest } = options;
  return { root, node, rest, plan };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

/**
 * Removes a checked scenario's repos, node and worktrees now, rather than leaving ~100 of them
 * for tempDir's afterEach, which can then overrun its hook timeout on a loaded machine.
 */
const dispose = (s: Scenario) => {
  for (const d of [s.root, s.node, s.rest.worktreesDir])
    rmSync(d, { recursive: true, force: true });
};

/** S2 is red on its first finished attempt, so the Return path is in every run. */
const redOnce = (ledger: () => Ledger): UnitGate => ({
  name: "red_once",
  run: ({ task }) =>
    task.id === "S2" &&
    !ledger()
      .read({ run_id: "R1", unit_id: "S2", types: ["unit.attempt.finished"] })
      .some((e) => (e.event.data as { outcome: string }).outcome === "red")
      ? { gate: "red_once", verdict: "fail", reason: "first try", evidence: [] }
      : { gate: "red_once", verdict: "pass", reason: "ok", evidence: [] },
});

/**
 * The fan-out shape (design 4.2-4.3): T1 -> T2, T3 -> T4, with T2 and T3 independent units in one
 * repo with disjoint scopes, run two at a time. T4 is red once, so the Return path is in it too.
 */
const unit = (id: string, t: Partial<Task>): Task => ({
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
const diamond: Shape = {
  plan: {
    schema: 1,
    brief_hash: briefHash(brief),
    tasks: [
      unit("T1", {
        project: "proto",
        kind: "codegen",
        covers: [],
        scope: ["loot.txt"],
        produces: ["proto:Loot"],
      }),
      unit("T2", { scope: ["a.sh"], consumes: ["proto:Loot"], produces: ["server:A"] }),
      unit("T3", { scope: ["b.sh"], consumes: ["proto:Loot"], produces: ["server:B"] }),
      unit("T4", { scope: ["c.sh"], consumes: ["server:A", "server:B"] }),
    ],
    risks: [],
  },
  commands: { server: { test: "test -f a.sh && test -f b.sh && test -f c.sh" } },
  parallel: 2,
};
const DIAMOND_FILES: Record<string, Record<string, string>> = {
  T1: { "loot.txt": "LootDrop\n" },
  T2: { "a.sh": "echo a\n" },
  T3: { "b.sh": "echo b\n" },
  T4: { "c.sh": "echo c\n" },
};

/**
 * T2 and T3 meet at a barrier before they finish, so both start from the same tip and the one
 * that joins second is replayed onto the other and re-gated. The barrier lets go once the other
 * has spawned in this process, is already accepted (a resume after its join), or the process is
 * dead (so a kill elsewhere doesn't hang the unit at the barrier).
 */
function diamondWorker(ledger: Ledger, dead: () => boolean): Worker {
  const spawned = new Set<string>();
  const other: Record<string, string> = { T2: "T3", T3: "T2" };
  const accepted = (id: string) =>
    ledger.read({ run_id: "R1", unit_id: id, types: ["unit.accepted"] }).length > 0;
  return {
    async spawn(input) {
      const id = input.brief.task.id;
      spawned.add(id);
      const peer = other[id];
      if (peer) {
        for (let i = 0; i < 2000 && !(spawned.has(peer) || accepted(peer) || dead()); i++)
          await new Promise((r) => setTimeout(r, 5));
      }
      const files = DIAMOND_FILES[id] ?? {};
      writeFiles(input.workdir, files);
      return {
        output: { schema: 1, summary: "", claims: [], touched: Object.keys(files) },
        transcript: "",
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        exit: "ok",
      };
    },
  };
}

/**
 * A `tests` gate, so it is one of the gates a join re-runs. On a join (the replay worktree) it
 * checks the combined tree holds both T2's and T3's work, and says so in its reason.
 */
const combinedTests: UnitGate = {
  name: "tests",
  run: ({ workdir }) => {
    if (!workdir.includes("-join"))
      return { gate: "tests", verdict: "pass", reason: "ok", evidence: [] };
    const both = existsSync(join(workdir, "a.sh")) && existsSync(join(workdir, "b.sh"));
    return both
      ? { gate: "tests", verdict: "pass", reason: "combined", evidence: [] }
      : { gate: "tests", verdict: "fail", reason: "join tree lacks a.sh or b.sh", evidence: [] };
  },
};

/** T4 is red on its first finished attempt. */
const t4RedOnce = (ledger: () => Ledger): UnitGate => ({
  name: "red_once",
  run: ({ task }) =>
    task.id === "T4" &&
    !ledger()
      .read({ run_id: "R1", unit_id: "T4", types: ["unit.attempt.finished"] })
      .some((e) => (e.event.data as { outcome: string }).outcome === "red")
      ? { gate: "red_once", verdict: "fail", reason: "first try", evidence: [] }
      : { gate: "red_once", verdict: "pass", reason: "ok", evidence: [] },
});

/** More attempts than any unit needs in one run (3 at most here): a restart loop. */
const MAX_ATTEMPTS_PER_RUN = 8;

/**
 * One process's build, stage and merge of the diamond. Attempts are counted per unit at the
 * runner (after a kill, attempts stop before the worker spawns): a unit started more than
 * MAX_ATTEMPTS_PER_RUN times fails the run at once, and its later attempts never settle, so a
 * scheduler that keeps restarting units fails the test in seconds instead of spinning.
 */
function diamondRun(s: Scenario, ledger: Ledger, kill?: ReturnType<typeof killer>) {
  const wrapped = kill ? kill.wrap(ledger) : ledger;
  const worker = diamondWorker(ledger, kill ? kill.dead : () => false);
  const gates = [combinedTests, t4RedOnce(() => ledger)];
  const local = localRunner({
    worker,
    gates,
    gateSandbox: s.rest.gateSandbox,
    worktreesDir: s.rest.worktreesDir,
    tools: s.rest.config.tools,
    gateTimeoutMs: s.rest.config.gateTimeoutMs,
  });
  const attempts = new Map<string, number>();
  let runaway: (e: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    runaway = reject;
  });
  const runner: Runner = {
    runAttempt(req, hooks) {
      const n = (attempts.get(req.task.id) ?? 0) + 1;
      attempts.set(req.task.id, n);
      if (n > MAX_ATTEMPTS_PER_RUN) {
        runaway(new Error(`${req.task.id} was started ${n} times in one run: a restart loop`));
        return new Promise(() => {});
      }
      return local.runAttempt(req, hooks);
    },
    rejoin: (req) => local.rejoin(req),
  };
  const run = pipeline(
    s,
    wrapped,
    { worker, runner, ...(kill ? { chaos: kill.chaos } : {}) },
    gates,
  );
  return Promise.race([run, failed]);
}

/** Joins that replayed a unit onto a moved tip and re-gated it green on the combined tree. */
function rejoins(node: string): string[] {
  const ledger = openLedger(node, { nodeId: "devserver" });
  const out = ledger
    .read({ run_id: "R1", types: ["gate.result"] })
    .filter((e) => (e.event.data as { reason: string }).reason === "combined")
    .map((e) => e.event.unit_id as string);
  ledger.close();
  return out;
}

/** What `heph run` then `heph approve merge` do, picking up from the run's status. */
async function pipeline(
  s: Scenario,
  ledger: Ledger,
  extra: Partial<RunPlanOptions> = {},
  gates: UnitGate[] = [redOnce(() => ledger)],
) {
  const opts = { ...s.rest, gates, ...extra, ledger };
  const status = () => ledger.run("R1")?.status;
  if (["planned", "running", "paused"].includes(status() as string)) {
    const out = await buildRun(opts);
    if (out.status !== "built") throw new Error(`build ${out.status}: ${out.reason}`);
  }
  if (status() === "built") await landChangeset({ ...opts, plan: s.plan });
  if (status() === "staged") await mergeChangeset({ ...opts, plan: s.plan });
}

async function outcome(s: Scenario) {
  const ledger = openLedger(s.node, { nodeId: "devserver" });
  const trees: Record<string, string> = {};
  const worktrees: Record<string, number> = {};
  const commits: Record<string, number> = {};
  for (const r of ["proto", "server", "web"]) {
    const cwd = join(s.root, r);
    trees[r] = await runOk(["git", "ls-tree", "-r", "main"], { cwd });
    commits[r] = Number((await runOk(["git", "rev-list", "--count", "main"], { cwd })).trim());
    worktrees[r] = (await runOk(["git", "worktree", "list"], { cwd })).trim().split("\n").length;
  }
  const accepted = ledger
    .read({ run_id: "R1", types: ["unit.accepted"] })
    .map((e) => e.event.unit_id)
    .sort();
  // Accepted work is never redone: one green attempt per unit, however often it was killed.
  const greens = ledger
    .read({ run_id: "R1", types: ["unit.attempt.finished"] })
    .filter((e) => (e.event.data as { outcome: string }).outcome === "green")
    .map((e) => e.event.unit_id)
    .sort();
  const result = {
    status: ledger.run("R1")?.status,
    trees,
    commits,
    greens,
    worktrees,
    accepted,
    pending: pendingEffects(ledger, "R1").map((e) => e.data.key),
  };
  ledger.close();
  return result;
}

describe("chaos", () => {
  test("a run killed at any point and resumed ends exactly like one never killed", async () => {
    const base = await scenario();
    const counter = killer(Number.POSITIVE_INFINITY);
    const ledger = openLedger(base.node, { nodeId: "devserver" });
    await pipeline(base, counter.wrap(ledger), { chaos: counter.chaos });
    ledger.close();
    const expected = await outcome(base);
    expect(expected).toMatchObject({
      status: "finished",
      accepted: ["P1", "S1", "S2"],
      greens: ["P1", "S1", "S2"],
      commits: { proto: 2, server: 3, web: 1 },
      pending: [],
      worktrees: { proto: 1, server: 1, web: 1 },
    });
    const points = counter.count();
    expect(points).toBeGreaterThan(30);

    for (let k = 0; k < points; k++) {
      const s = await scenario();
      const kill = killer(k);
      const first = openLedger(s.node, { nodeId: "devserver" });
      const killed = await pipeline(s, kill.wrap(first), { chaos: kill.chaos }).then(
        () => false,
        (e) => {
          if (!(e instanceof Stopped)) throw e;
          return true;
        },
      );
      first.close();
      expect(killed).toBe(true);

      // A new process: the ledger reopened from disk, nothing carried over in memory.
      const second = openLedger(s.node, { nodeId: "devserver" });
      await pipeline(s, second);
      second.close();
      const got = await outcome(s);
      expect({ k, ...got }).toEqual({ k, ...expected });
      dispose(s);
    }
  }, 600_000);
  test("a fan-out run at parallel 2 killed at any point and resumed ends like one never killed", async () => {
    const base = await scenario(diamond);
    const counter = killer(Number.POSITIVE_INFINITY);
    const ledger = openLedger(base.node, { nodeId: "devserver" });
    await diamondRun(base, ledger, counter);
    ledger.close();
    const expected = await outcome(base);
    expect(expected).toMatchObject({
      status: "finished",
      accepted: ["T1", "T2", "T3", "T4"],
      greens: ["T1", "T2", "T3", "T4"],
      commits: { proto: 2, server: 4, web: 1 },
      pending: [],
      worktrees: { proto: 1, server: 1, web: 1 },
    });
    // The barrier makes T2 and T3 finish from one tip: one of them went through the join.
    const joined = rejoins(base.node);
    expect(joined).toHaveLength(1);
    expect(["T2", "T3"]).toContain(joined[0] as string);
    const points = counter.count();
    expect(points).toBeGreaterThan(30);

    // Scheduling order may vary between runs, so outcomes compare trees and per-unit counts.
    for (let k = 0; k < points; k++) {
      const s = await scenario(diamond);
      const kill = killer(k);
      const first = openLedger(s.node, { nodeId: "devserver" });
      const killed = await diamondRun(s, first, kill).then(
        () => false,
        (e) => {
          if (!(e instanceof Stopped)) throw e;
          return true;
        },
      );
      first.close();
      expect({ k, killed }).toEqual({ k, killed: true });

      const second = openLedger(s.node, { nodeId: "devserver" });
      await diamondRun(s, second);
      second.close();
      const got = await outcome(s);
      expect({ k, ...got }).toEqual({ k, ...expected });
      dispose(s);
    }
  }, 240_000);
});
