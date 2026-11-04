import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openLedger } from "@hephaestus/ledger";
import { buildRun, createRun, type RunPlanOptions, recordPlan, runPlan } from "../src/engine.ts";
import type { SpawnInput, Worker } from "../src/worker.ts";
import { tempDir, writeFiles } from "./helpers.ts";
import { brief, config, crossRepoFiles, crossRepoPlan, threeRepos } from "./workspace.ts";

const dir = tempDir();

function recordingWorker(onSpawn?: (input: SpawnInput) => void) {
  const inputs: SpawnInput[] = [];
  const worker: Worker = {
    async spawn(input) {
      inputs.push(input);
      onSpawn?.(input);
      const files = crossRepoFiles[input.brief.task.id as keyof typeof crossRepoFiles] ?? {};
      writeFiles(input.workdir, files);
      return {
        output: { schema: 1, summary: "", claims: [], touched: Object.keys(files) },
        transcript: "",
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        exit: "ok",
      };
    },
  };
  return { worker, inputs };
}

async function setup(worker: Worker) {
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
    worker,
    gates: [],
    config,
    worktreesDir: join(dir(), "worktrees"),
  };
  return { ledger, options };
}

describe("createRun, recordPlan, buildRun", () => {
  test("a run created and planned earlier builds from what the ledger holds", async () => {
    const { worker, inputs } = recordingWorker();
    const { ledger, options } = await setup(worker);
    createRun(options);
    const planId = recordPlan(options, options.plan);
    expect(ledger.read({ types: ["run.created"] })[0]?.event.data).toMatchObject({
      brief,
      workspace_root: options.workspaceRoot,
    });
    expect(ledger.read({ types: ["run.plan_ready"] })[0]?.event.id).toBe(planId);

    const { brief: _b, plan: _p, ...rest } = options;
    const out = await buildRun(rest);
    expect(out.status).toBe("built");
    expect(inputs.map((i) => i.brief.task.id)).toEqual(["P1", "S1", "S2"]);
    ledger.close();
  });

  test("buildRun uses the latest plan when it was revised", async () => {
    const { worker, inputs } = recordingWorker();
    const { ledger, options } = await setup(worker);
    createRun(options);
    recordPlan(options, options.plan);
    const revised = { ...options.plan, tasks: options.plan.tasks.filter((t) => t.id === "P1") };
    recordPlan(options, revised);
    const { brief: _b, plan: _p, ...rest } = options;
    await buildRun(rest);
    expect(inputs.map((i) => i.brief.task.id)).toEqual(["P1"]);
    ledger.close();
  });

  test("hints and a budget override reach the next attempt of their unit", async () => {
    const { worker, inputs } = recordingWorker();
    const { ledger, options } = await setup(worker);
    createRun(options);
    recordPlan(options, options.plan);
    const base = { run_id: "R1", changeset_id: "C1", config_hash: "cli", actor: "human" as const };
    ledger.appendMany([
      {
        ...base,
        type: "human.input",
        unit_id: "S2",
        data: { kind: "hint", text: "reuse the loot table" },
      },
      { ...base, type: "human.input", data: { kind: "hint", text: "keep messages short" } },
      {
        ...base,
        type: "human.input",
        unit_id: "S2",
        data: { kind: "budget_override", budget_tokens: 4321 },
      },
    ]);
    const { brief: _b, plan: _p, ...rest } = options;
    await buildRun(rest);
    const s1 = inputs.find((i) => i.brief.task.id === "S1");
    const s2 = inputs.find((i) => i.brief.task.id === "S2");
    expect(s1?.brief.constraints).toEqual(["Hint from the user: keep messages short"]);
    expect(s2?.brief.constraints).toEqual([
      "Hint from the user: reuse the loot table",
      "Hint from the user: keep messages short",
    ]);
    expect(s2?.brief.context.budget_tokens).toBe(4321);
    expect(s1?.brief.context.budget_tokens).toBe(config.budgetTokens);
    ledger.close();
  });

  test("a cancelled run stops before its next attempt", async () => {
    let ledgerRef: ReturnType<typeof openLedger> | undefined;
    const { worker, inputs } = recordingWorker((input) => {
      if (input.brief.task.id === "P1") {
        ledgerRef?.append({
          run_id: "R1",
          changeset_id: "C1",
          config_hash: "cli",
          actor: "human",
          type: "run.failed",
          data: { reason: "cancelled by user" },
        });
      }
    });
    const { ledger, options } = await setup(worker);
    ledgerRef = ledger;
    const out = await runPlan(options);
    expect(out).toMatchObject({ status: "cancelled", reason: "cancelled by user" });
    expect(inputs.map((i) => i.brief.task.id)).toEqual(["P1"]);
    expect(ledger.run("R1")?.status).toBe("failed");
    ledger.close();
  });
});
