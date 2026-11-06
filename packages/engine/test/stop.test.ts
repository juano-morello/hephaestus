import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Plan } from "@hephaestus/core";
import { type Ledger, type LedgerEvent, openLedger } from "@hephaestus/ledger";
import { buildRun, createRun, type RunPlanOptions, recordPlan } from "../src/engine.ts";
import type { UnitGate } from "../src/gates.ts";
import type { Worker } from "../src/worker.ts";
import { tempDir, writeFiles } from "./helpers.ts";
import { brief, config, crossRepoFiles, crossRepoPlan, threeRepos } from "./workspace.ts";

const dir = tempDir();

/** Writes each unit's files. `hold` units wait for the signal and then stop, as OMP does. */
function worker(opts: { hold?: string; onSpawn?: (id: string) => void; delayMs?: number } = {}) {
  const ids: string[] = [];
  /** Whether each worker's own signal was aborted when it finished. */
  const aborted: boolean[] = [];
  const w: Worker = {
    async spawn(input) {
      const id = input.brief.task.id;
      ids.push(id);
      opts.onSpawn?.(id);
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
      if (id === opts.hold) {
        while (!input.signal?.aborted) await Bun.sleep(5);
        return {
          output: undefined,
          transcript: "",
          usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          exit: "interrupted",
        };
      }
      const files = crossRepoFiles[id as keyof typeof crossRepoFiles] ?? {};
      writeFiles(input.workdir, files);
      aborted.push(input.signal?.aborted === true);
      return {
        output: { schema: 1, summary: "", claims: [], touched: Object.keys(files) },
        transcript: "",
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        exit: "ok",
      };
    },
  };
  return { w, ids, aborted };
}

async function setup(plan: Plan = crossRepoPlan(), over: Partial<RunPlanOptions> = {}) {
  const { root, workspace } = await threeRepos(dir());
  const ledger = openLedger(join(dir(), "node"), { nodeId: "devserver" });
  const options: RunPlanOptions = {
    ledger,
    workspace,
    workspaceRoot: root,
    brief,
    plan,
    runId: "R1",
    changesetId: "C1",
    worker: worker().w,
    gates: [],
    config,
    worktreesDir: join(dir(), "worktrees"),
    ...over,
  };
  createRun(options);
  recordPlan(options, options.plan);
  const { brief: _b, plan: _p, ...rest } = options;
  return { ledger, rest };
}

const of = (ledger: Ledger, type: string) =>
  ledger
    .read({ run_id: "R1", types: [type] })
    .map((s) => s.event as LedgerEvent & { data: Record<string, unknown> });

describe("stopping a build", () => {
  test("a handoff interrupts the attempt in flight; it doesn't count and runs again on resume", async () => {
    const { ledger, rest } = await setup();
    const stop = new AbortController();
    const first = worker({ hold: "S1", onSpawn: (id) => id === "S1" && stop.abort("handoff") });
    const out = await buildRun({ ...rest, worker: first.w, signal: stop.signal });
    expect(out).toMatchObject({ status: "paused", reason: "S1: handoff" });
    expect(of(ledger, "unit.attempt.interrupted")).toMatchObject([
      { unit_id: "S1", attempt: 1, data: { reason: "handoff" } },
    ]);
    expect(of(ledger, "run.paused").map((e) => e.data.reason)).toEqual(["handoff"]);

    const next = worker();
    expect((await buildRun({ ...rest, worker: next.w })).status).toBe("built");
    expect(next.ids).toEqual(["S1", "S2"]);
    expect(of(ledger, "run.resumed").map((e) => e.data.reason)).toEqual(["handoff"]);
    expect(ledger.units("R1").find((u) => u.unit_id === "S1")?.attempts).toBe(1);
    ledger.close();
  });

  test("a worker that finishes anyway is kept, and the build stops before the next unit", async () => {
    const { ledger, rest } = await setup();
    const stop = new AbortController();
    const w = worker({ onSpawn: (id) => id === "P1" && stop.abort("cancelled") });
    const out = await buildRun({ ...rest, worker: w.w, signal: stop.signal });
    expect(out).toMatchObject({ status: "paused", reason: "user" });
    expect(w.ids).toEqual(["P1"]);
    expect(of(ledger, "unit.accepted").map((e) => e.unit_id)).toEqual(["P1"]);
    ledger.close();
  });
});

describe("draining a build", () => {
  test("drain raised mid-attempt lets the attempt finish and starts no second unit", async () => {
    const { ledger, rest } = await setup();
    const drain = new AbortController();
    const w = worker({ onSpawn: (id) => id === "P1" && drain.abort("handoff") });
    const out = await buildRun({ ...rest, worker: w.w, drain: drain.signal });
    expect(out).toMatchObject({ status: "paused", reason: "handoff" });
    expect(w.ids).toEqual(["P1"]);
    expect(of(ledger, "unit.accepted").map((e) => e.unit_id)).toEqual(["P1"]);
    expect(w.aborted).toEqual([false]);
    expect(of(ledger, "run.paused").map((e) => e.data.reason)).toEqual(["handoff"]);
    ledger.close();
  });

  test("drain raised before any unit starts pauses with handoff and runs nothing", async () => {
    const { ledger, rest } = await setup();
    const drain = new AbortController();
    drain.abort("handoff");
    const w = worker();
    const out = await buildRun({ ...rest, worker: w.w, drain: drain.signal });
    expect(out).toMatchObject({ status: "paused", reason: "handoff" });
    expect(w.ids).toEqual([]);
    expect(of(ledger, "unit.attempt.started")).toEqual([]);
    ledger.close();
  });

  test("a red attempt under drain records its Return and stops without another attempt", async () => {
    const redOnce: UnitGate = {
      name: "red_once",
      run: (ctx) =>
        ctx.attempt === 1
          ? { gate: "red_once", verdict: "fail", reason: "first attempt", evidence: ["x"] }
          : { gate: "red_once", verdict: "pass", reason: "ok", evidence: [] },
    };
    const { ledger, rest } = await setup(crossRepoPlan(), { gates: [redOnce] });
    const drain = new AbortController();
    const first = worker({ onSpawn: (id) => id === "P1" && drain.abort("handoff") });
    const out = await buildRun({ ...rest, worker: first.w, drain: drain.signal });
    expect(out).toMatchObject({ status: "paused", reason: "P1: handoff" });
    expect(of(ledger, "run.paused").map((e) => e.data.reason)).toEqual(["handoff"]);
    expect(of(ledger, "unit.attempt.started")).toHaveLength(1);
    expect(of(ledger, "unit.attempt.finished")).toMatchObject([
      { unit_id: "P1", data: { outcome: "red" } },
    ]);
    expect(of(ledger, "unit.returned")).toHaveLength(1);

    const next = worker();
    expect((await buildRun({ ...rest, worker: next.w, gates: [redOnce] })).status).toBe("built");
    expect(next.ids[0]).toBe("P1");
    expect(ledger.units("R1").find((u) => u.unit_id === "P1")?.attempts).toBe(2);
    ledger.close();
  });

  test("with parallel 2 both in-flight attempts finish before the pause", async () => {
    const base = crossRepoPlan();
    const [p1, s1, s2] = base.tasks as [
      Plan["tasks"][number],
      Plan["tasks"][number],
      Plan["tasks"][number],
    ];
    // P1 (proto) and S2 (server) are independent; S1 waits for P1's artifact.
    const plan: Plan = { ...base, tasks: [p1, { ...s2, consumes: [], covers: [] }, s1] };
    const { ledger, rest } = await setup(plan, { config: { ...config, parallel: 2 } });
    const drain = new AbortController();
    const w = worker({ delayMs: 40, onSpawn: (id) => id === "P1" && drain.abort("handoff") });
    const out = await buildRun({ ...rest, worker: w.w, drain: drain.signal });
    expect(out).toMatchObject({ status: "paused", reason: "handoff" });
    expect(new Set(w.ids)).toEqual(new Set(["P1", "S2"]));
    expect(
      of(ledger, "unit.accepted")
        .map((e) => e.unit_id)
        .sort(),
    ).toEqual(["P1", "S2"]);
    expect(w.aborted).toEqual([false, false]);
    ledger.close();
  });
});
