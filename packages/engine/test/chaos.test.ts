import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type EventDraft, type Ledger, type LedgerEvent, openLedger } from "@hephaestus/ledger";
import { openSandbox, runOk } from "@hephaestus/sandbox";
import { pendingEffects, Stopped } from "../src/effects.ts";
import { buildRun, createRun, type RunPlanOptions, recordPlan } from "../src/engine.ts";
import type { UnitGate } from "../src/gates.ts";
import { landChangeset, mergeChangeset } from "../src/land.ts";
import { tempDir } from "./helpers.ts";
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
  return { wrap, chaos: (_p: string) => hit(), count: () => n };
}

async function scenario() {
  const { root, workspace } = await threeRepos(dir());
  const node = join(dir(), "node");
  const ledger = openLedger(node, { nodeId: "devserver" });
  const options: RunPlanOptions = {
    ledger,
    workspace,
    workspaceRoot: root,
    brief,
    plan: crossRepoPlan(),
    runId: "R1",
    changesetId: "C1",
    worker: writer,
    gates: [],
    config: { ...config, commands: { server: { test: "sh check.sh" } } },
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

/** What `heph run` then `heph approve merge` do, picking up from the run's status. */
async function pipeline(s: Scenario, ledger: Ledger, extra: Partial<RunPlanOptions> = {}) {
  const opts = { ...s.rest, ...extra, ledger, gates: [redOnce(() => ledger)] };
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
    }
  }, 600_000);
});
