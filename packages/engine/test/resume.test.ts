import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { EventDraft, Ledger, LedgerEvent } from "@hephaestus/ledger";
import { openLedger } from "@hephaestus/ledger";
import { pendingEffects } from "../src/effects.ts";
import { buildRun, createRun, type RunPlanOptions, recordPlan } from "../src/engine.ts";
import type { UnitGate } from "../src/gates.ts";
import { createGit } from "../src/git.ts";
import type { SpawnInput, SpawnOutput, Worker } from "../src/worker.ts";
import { tempDir, writeFiles } from "./helpers.ts";
import { brief, config, crossRepoFiles, crossRepoPlan, threeRepos } from "./workspace.ts";

const dir = tempDir();

class Crash extends Error {}

/** A worker that writes each unit's files; `exit` can stand in for what a unit returns. */
function scripted(exit: (input: SpawnInput) => SpawnOutput["exit"] = () => "ok") {
  const inputs: SpawnInput[] = [];
  const worker: Worker = {
    async spawn(input) {
      inputs.push(input);
      const files = crossRepoFiles[input.brief.task.id as keyof typeof crossRepoFiles] ?? {};
      writeFiles(input.workdir, files);
      return {
        output: { schema: 1, summary: "", claims: [], touched: Object.keys(files) },
        transcript: "",
        usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
        exit: exit(input),
      };
    },
  };
  return { worker, inputs, ids: () => inputs.map((i) => `${i.brief.task.id}`) };
}

/** Throws before committing the first batch that matches, as a killed process would stop. */
function crashing(ledger: Ledger, when: (drafts: EventDraft[]) => boolean): Ledger {
  let crashed = false;
  const appendMany = (drafts: EventDraft[]): LedgerEvent[] => {
    if (crashed || when(drafts)) {
      crashed = true;
      throw new Crash("killed");
    }
    return ledger.appendMany(drafts);
  };
  return {
    ...ledger,
    appendMany,
    append: ((d: EventDraft) => appendMany([d])[0]) as Ledger["append"],
  };
}

async function setup(gates: UnitGate[] = []) {
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
    worker: scripted().worker,
    gates,
    config,
    worktreesDir: join(dir(), "worktrees"),
  };
  createRun(options);
  recordPlan(options, options.plan);
  const { brief: _b, plan: _p, ...rest } = options;
  const git = (r: string) => createGit(join(root, r));
  return { ledger, rest, options, git, node };
}

const of = (ledger: Ledger, type: string) =>
  ledger
    .read({ run_id: "R1", types: [type] })
    .map((s) => s.event as LedgerEvent & { data: Record<string, unknown> });

describe("resuming a build", () => {
  test("accepted units are kept; their files stay locked for the units after them", async () => {
    const { ledger, rest, git } = await setup();
    const first = scripted((i) => (i.brief.task.id === "S2" ? "rate_limited" : "ok"));
    let reaped = 0;
    const reapSandboxes = async () => void reaped++;
    const paused = await buildRun({ ...rest, worker: first.worker, reapSandboxes });
    expect(paused.status).toBe("paused");
    const serverTip = await git("server").revParse("heph/R1");

    const second = scripted();
    const out = await buildRun({ ...rest, worker: second.worker, reapSandboxes });
    expect(out.status).toBe("built");
    expect(reaped).toBe(2);
    expect(second.ids()).toEqual(["S2"]);
    expect(second.inputs[0]?.brief.locked_paths).toEqual(["check.sh"]);
    expect(second.inputs[0]?.workdir).toContain(join("S2", "a2"));
    expect(await git("server").revParse("heph/R1~1")).toBe(serverTip);
    expect(of(ledger, "run.resumed").map((e) => e.data.reason)).toEqual(["rate_limit"]);
    expect(of(ledger, "unit.accepted").map((e) => e.unit_id)).toEqual(["P1", "S1", "S2"]);
    expect(of(ledger, "effect.intended").map((e) => e.data.effect)).toEqual([
      "run_branch_reset",
      "run_branch_reset",
      "run_branch_advance",
      "run_branch_advance",
      "run_branch_advance",
    ]);
    expect(pendingEffects(ledger, "R1")).toEqual([]);
    ledger.close();
  });

  test("an attempt a crash cut off is interrupted, does not count, and runs again", async () => {
    const { ledger, rest, node } = await setup();
    const killed = crashing(ledger, (ds) =>
      ds.some((d) => d.type === "unit.attempt.finished" && d.unit_id === "S1"),
    );
    await expect(buildRun({ ...rest, ledger: killed })).rejects.toBeInstanceOf(Crash);
    ledger.close();

    // A new process: the ledger reopened from disk.
    const reopened = openLedger(node, { nodeId: "devserver" });
    const next = scripted();
    const out = await buildRun({ ...rest, ledger: reopened, worker: next.worker });
    expect(out.status).toBe("built");
    expect(next.ids()).toEqual(["S1", "S2"]);
    expect(of(reopened, "unit.attempt.interrupted")).toMatchObject([
      { unit_id: "S1", attempt: 1, data: { reason: "crash" } },
    ]);
    expect(of(reopened, "run.resumed").map((e) => e.data.reason)).toEqual(["crash"]);
    expect(reopened.units("R1").find((u) => u.unit_id === "S1")).toMatchObject({
      status: "accepted",
      attempts: 1,
    });
    expect(of(reopened, "unit.accepted").filter((e) => e.unit_id === "S1")).toMatchObject([
      { attempt: 2 },
    ]);
    reopened.close();
  });

  test("a crash between accepting the attempt and moving the run branch is finished on resume", async () => {
    const { ledger, rest, node, git } = await setup();
    const killed = crashing(ledger, (ds) =>
      ds.some((d) => d.type === "effect.done" && d.unit_id === "S1"),
    );
    await expect(buildRun({ ...rest, ledger: killed })).rejects.toBeInstanceOf(Crash);
    ledger.close();
    const moved = await git("server").revParse("heph/R1");

    const reopened = openLedger(node, { nodeId: "devserver" });
    const next = scripted();
    expect((await buildRun({ ...rest, ledger: reopened, worker: next.worker })).status).toBe(
      "built",
    );
    expect(next.ids()).toEqual(["S2"]);
    expect(await git("server").revParse("heph/R1~1")).toBe(moved);
    expect(of(reopened, "effect.done").find((e) => e.unit_id === "S1")?.data.state).toBe(
      "confirmed",
    );
    expect(of(reopened, "unit.accepted").map((e) => e.unit_id)).toEqual(["P1", "S1", "S2"]);
    reopened.close();
  });

  test("an escalated unit gets a fresh set of attempts, with the feedback and new hints", async () => {
    let fail = true;
    let calls = 0;
    const gate: UnitGate = {
      name: "flaky",
      run: ({ task }) =>
        fail && task.id === "S2"
          ? { gate: "flaky", verdict: "fail", reason: "still red", evidence: [`e${++calls}`] }
          : { gate: "flaky", verdict: "pass", reason: "ok", evidence: [] },
    };
    const { ledger, rest } = await setup([gate]);
    const first = scripted();
    expect((await buildRun({ ...rest, worker: first.worker })).status).toBe("paused");
    expect(ledger.units("R1").find((u) => u.unit_id === "S2")?.status).toBe("escalated");

    ledger.append({
      run_id: "R1",
      changeset_id: "C1",
      config_hash: "cli",
      actor: "human",
      unit_id: "S2",
      type: "human.input",
      data: { kind: "hint", text: "the loot table is in loot.txt" },
    });
    fail = false;
    const next = scripted();
    expect((await buildRun({ ...rest, worker: next.worker })).status).toBe("built");
    expect(next.ids()).toEqual(["S2"]);
    const s2 = next.inputs[0];
    expect(s2?.brief.feedback?.attempt).toBe(3);
    expect(s2?.brief.constraints).toContain("Hint from the user: the loot table is in loot.txt");
    expect(of(ledger, "unit.accepted").find((e) => e.unit_id === "S2")?.attempt).toBe(4);
    expect(of(ledger, "run.resumed").map((e) => e.data.reason)).toEqual(["user"]);
    ledger.close();
  });

  test("a unit escalating again says how many attempts it had in all", async () => {
    let calls = 0;
    const gate: UnitGate = {
      name: "red",
      run: ({ task }) =>
        task.id === "S2"
          ? { gate: "red", verdict: "fail", reason: "red", evidence: [`call ${++calls}`] }
          : { gate: "red", verdict: "pass", reason: "ok", evidence: [] },
    };
    const { ledger, rest } = await setup([gate]);
    expect(await buildRun({ ...rest, worker: scripted().worker })).toMatchObject({
      reason: "S2: red after 3 attempts",
    });
    expect(await buildRun({ ...rest, worker: scripted().worker })).toMatchObject({
      reason: "S2: red after 3 more attempts (6 in all)",
    });
    ledger.close();
  });

  test("a crash after the last attempt but before the escalation escalates without a new attempt", async () => {
    let calls = 0;
    const gate: UnitGate = {
      name: "red",
      run: ({ task }) =>
        task.id === "S2"
          ? { gate: "red", verdict: "fail", reason: "red", evidence: [`call ${++calls}`] }
          : { gate: "red", verdict: "pass", reason: "ok", evidence: [] },
    };
    const { ledger, rest, node } = await setup([gate]);
    const killed = crashing(ledger, (ds) => ds.some((d) => d.type === "unit.escalated"));
    await expect(buildRun({ ...rest, ledger: killed })).rejects.toBeInstanceOf(Crash);
    ledger.close();

    const reopened = openLedger(node, { nodeId: "devserver" });
    const next = scripted();
    const out = await buildRun({ ...rest, ledger: reopened, worker: next.worker });
    expect(out).toMatchObject({ status: "paused", reason: "S2: red after 3 attempts" });
    expect(next.ids()).toEqual([]);
    reopened.close();
  });

  test("a crash after an escalation but before run.paused pauses again, without fresh attempts", async () => {
    let fail = true;
    const gate: UnitGate = {
      name: "red",
      run: ({ task }) =>
        fail && task.id === "S2"
          ? { gate: "red", verdict: "fail", reason: "red", evidence: [] }
          : { gate: "red", verdict: "pass", reason: "ok", evidence: [] },
    };
    const { ledger, rest, node } = await setup([gate]);
    const killed = crashing(ledger, (ds) => ds.some((d) => d.type === "run.paused"));
    await expect(buildRun({ ...rest, ledger: killed })).rejects.toBeInstanceOf(Crash);
    ledger.close();

    const reopened = openLedger(node, { nodeId: "devserver" });
    expect(reopened.run("R1")?.status).toBe("running");
    const next = scripted();
    const out = await buildRun({ ...rest, ledger: reopened, worker: next.worker });
    expect(out).toMatchObject({ status: "paused", reason: "S2: red after 3 attempts" });
    expect(next.ids()).toEqual([]);
    expect(of(reopened, "run.paused").map((e) => e.data)).toEqual([{ reason: "user" }]);
    expect(of(reopened, "unit.attempt.started").filter((e) => e.unit_id === "S2")).toHaveLength(3);
    expect(reopened.units("R1").find((u) => u.unit_id === "S2")).toMatchObject({
      status: "escalated",
      attempts: 3,
    });

    // The user resuming it is what gives the unit a fresh set of attempts.
    fail = false;
    const after = scripted();
    expect((await buildRun({ ...rest, ledger: reopened, worker: after.worker })).status).toBe(
      "built",
    );
    expect(after.ids()).toEqual(["S2"]);
    expect(of(reopened, "unit.accepted").find((e) => e.unit_id === "S2")?.attempt).toBe(4);
    reopened.close();
  });

  test("a crash after a rate-limited attempt but before run.paused pauses for the rate limit", async () => {
    const { ledger, rest, node } = await setup();
    const killed = crashing(ledger, (ds) => ds.some((d) => d.type === "run.paused"));
    const first = scripted((i) => (i.brief.task.id === "S2" ? "rate_limited" : "ok"));
    await expect(
      buildRun({ ...rest, ledger: killed, worker: first.worker }),
    ).rejects.toBeInstanceOf(Crash);
    ledger.close();

    const reopened = openLedger(node, { nodeId: "devserver" });
    const next = scripted();
    const out = await buildRun({ ...rest, ledger: reopened, worker: next.worker });
    expect(out).toMatchObject({ status: "paused", reason: "S2: rate_limit" });
    expect(next.ids()).toEqual([]);
    expect(of(reopened, "run.paused").map((e) => e.data.reason)).toEqual(["rate_limit"]);
    reopened.close();
  });

  test("a build after a plan revision starts fresh from the targets", async () => {
    const { ledger, rest, options, git } = await setup();
    const first = scripted((i) => (i.brief.task.id === "S2" ? "rate_limited" : "ok"));
    await buildRun({ ...rest, worker: first.worker });
    recordPlan(options, options.plan);

    const next = scripted();
    expect((await buildRun({ ...rest, worker: next.worker })).status).toBe("built");
    expect(next.ids()).toEqual(["P1", "S1", "S2"]);
    expect(await git("server").revParse("heph/R1~2")).toBe(await git("server").revParse("main"));
    expect(of(ledger, "run.resumed")).toEqual([]);
    ledger.close();
  });
});
