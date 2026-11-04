import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Ledger, type LedgerEvent, openLedger } from "@hephaestus/ledger";
import { buildRun, createRun, type RunPlanOptions, recordPlan } from "../src/engine.ts";
import type { Worker } from "../src/worker.ts";
import { tempDir, writeFiles } from "./helpers.ts";
import { brief, config, crossRepoFiles, crossRepoPlan, threeRepos } from "./workspace.ts";

const dir = tempDir();

/** Writes each unit's files. `hold` units wait for the signal and then stop, as OMP does. */
function worker(opts: { hold?: string; onSpawn?: (id: string) => void } = {}) {
  const ids: string[] = [];
  const w: Worker = {
    async spawn(input) {
      const id = input.brief.task.id;
      ids.push(id);
      opts.onSpawn?.(id);
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
      return {
        output: { schema: 1, summary: "", claims: [], touched: Object.keys(files) },
        transcript: "",
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        exit: "ok",
      };
    },
  };
  return { w, ids };
}

async function setup() {
  const { root, workspace } = await threeRepos(dir());
  const ledger = openLedger(join(dir(), "node"), { nodeId: "devserver" });
  const options: RunPlanOptions = {
    ledger,
    workspace,
    workspaceRoot: root,
    brief,
    plan: crossRepoPlan(),
    runId: "R1",
    changesetId: "C1",
    worker: worker().w,
    gates: [],
    config,
    worktreesDir: join(dir(), "worktrees"),
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
