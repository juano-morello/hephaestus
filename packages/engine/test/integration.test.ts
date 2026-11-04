import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "@hephaestus/ledger";
import { openSandbox, type Sandbox } from "@hephaestus/sandbox";
import { type RunPlanOptions, runPlan } from "../src/engine.ts";
import type { Worker } from "../src/worker.ts";
import { tempDir, writeFiles } from "./helpers.ts";
import {
  brief,
  config,
  crossRepoFiles,
  crossRepoPlan,
  threeRepos,
  writeScript,
} from "./workspace.ts";

const dir = tempDir();

/** Writes each unit's files and reports them as touched. */
const writer: Worker = {
  async spawn(input) {
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

async function run(script: string | undefined, extra: Partial<RunPlanOptions> = {}) {
  const { root, workspace } = await threeRepos(
    dir(),
    script ? { integration: { gate: "./scripts/integration.sh" } } : {},
  );
  if (script) writeScript(root, "scripts/integration.sh", script);
  const ledger = openLedger(join(dir(), "node"), { nodeId: "devserver" });
  const seen: string[] = [];
  const integrationSandbox = async (d: string): Promise<Sandbox> => {
    seen.push(d);
    return openSandbox({ mode: "native", hostDir: d });
  };
  const worktreesDir = join(dir(), "worktrees");
  const result = await runPlan({
    ledger,
    workspace,
    workspaceRoot: root,
    brief,
    plan: crossRepoPlan(),
    runId: "R1",
    changesetId: "C1",
    worker: writer,
    gates: [],
    config,
    worktreesDir,
    integrationSandbox,
    ...extra,
  });
  const gate = ledger
    .read({ types: ["gate.result"] })
    .find((e) => (e.event.data as { gate: string }).gate === "integration");
  return { result, ledger, gate, seen, worktreesDir };
}

describe("integration gate", () => {
  test("runs over the assembled changeset: touched repos at their run tips, the rest at target", async () => {
    const script =
      "set -e\ntest -f proto/loot.txt\ntest -f server/impl.sh\ntest -f web/index.html\necho ok\n";
    const { result, ledger, gate, seen } = await run(script);
    expect(result.status).toBe("built");
    expect(gate?.event).toMatchObject({
      actor: "gate",
      data: { gate: "integration", verdict: "pass" },
    });
    expect(gate?.event.unit_id).toBeUndefined();
    expect(ledger.run("R1")?.status).toBe("built");
    expect(seen).toHaveLength(1);
    expect(existsSync(seen[0] as string)).toBe(false);
    ledger.close();
  });

  test("a red integration gate pauses the run with its output as evidence", async () => {
    const { result, ledger, gate } = await run('echo "bot could not connect"\nexit 1\n');
    expect(result).toMatchObject({ status: "paused", reason: "integration gate failed" });
    expect(gate?.event.data).toMatchObject({
      verdict: "fail",
      reason: "integration gate failed",
      evidence: ["exit 1", "bot could not connect"],
    });
    expect(ledger.run("R1")?.status).toBe("paused");
    ledger.close();
  });

  test("no integration gate configured is recorded as skipped", async () => {
    const { result, gate, seen, ledger } = await run(undefined);
    expect(result.status).toBe("built");
    expect(gate?.event.data).toMatchObject({
      verdict: "pass",
      reason: "skipped: no integration gate configured",
    });
    expect(seen).toEqual([]);
    ledger.close();
  });

  test("a configured gate without a sandbox fails clearly", async () => {
    const { result, gate, ledger } = await run("exit 0\n", { integrationSandbox: undefined });
    expect(result.status).toBe("paused");
    expect(gate?.event.data).toMatchObject({
      verdict: "fail",
      reason: "no sandbox configured for the integration gate",
    });
    ledger.close();
  });
});
