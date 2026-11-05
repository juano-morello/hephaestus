import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Brief, GateResult, Plan, Task, Workspace } from "@hephaestus/core";
import { briefHash } from "@hephaestus/core";
import { type Ledger, openLedger } from "@hephaestus/ledger";
import { run, runOk, type Sandbox } from "@hephaestus/sandbox";
import { builtinGates, lintGate, testsGate, typecheckGate } from "../src/builtin-gates.ts";
import type { EngineConfig } from "../src/config.ts";
import { pendingEffects, reconcile, Stopped } from "../src/effects.ts";
import { buildRun, type RunPlanOptions, realityOf, runPlan } from "../src/engine.ts";
import type { UnitGate } from "../src/gates.ts";
import { joinLocks } from "../src/join.ts";
import { localRunner, type Runner } from "../src/runner.ts";
import type { SpawnInput, Worker } from "../src/worker.ts";
import { initRepo, tempDir, writeFiles } from "./helpers.ts";

const dir = tempDir();

const brief: Brief = {
  schema: 1,
  goal: "two things",
  context: "",
  decisions: [],
  constraints: [],
  acceptance: [{ id: "AC1", text: "both done", kind: "behavior" }],
  out_of_scope: [],
  open_questions: [],
  source: "cli",
};

const workspace: Workspace = {
  repos: { game: "." },
  projects: { server: { repo: "game", path: "server", stack: "go" } },
};

const task = (id: string, scope: string[]): Task => ({
  id,
  title: id,
  kind: "implement",
  project: "server",
  lane: "contained",
  complexity: "standard",
  complexity_reason: "x",
  scope,
  covers: ["AC1"],
  spec: `do ${id}`,
});

const plan = (tasks: Task[]): Plan => ({
  schema: 1,
  brief_hash: briefHash(brief),
  tasks,
  risks: [],
});

const config = (parallel: number, test = "true"): EngineConfig => ({
  routing: {
    implementer: { default: { model: "claude/sonnet" } },
    test_author: { default: { model: "claude/sonnet" } },
  },
  maxAttempts: 3,
  parallel,
  budgetTokens: 20_000,
  tools: ["read", "edit", "bash"],
  commands: { server: { test, typecheck: "true", lint: "true" } },
});

const usage = { input: 1, output: 1, cache_read: 0, cache_write: 0 };
const until = async (cond: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 2000 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 5));
};

type Step = { files: Record<string, string>; wait?: () => Promise<void> };

/** Writes each unit's scripted files; `wait` holds a step back until the test lets it go. */
function scripted(script: Record<string, Step[]>) {
  const spawned: string[] = [];
  const worker: Worker = {
    async spawn(input: SpawnInput) {
      const id = input.brief.task.id;
      const n = spawned.filter((s) => s === id).length;
      spawned.push(id);
      const step = script[id]?.[n] ?? { files: {} };
      await step.wait?.();
      writeFiles(input.workdir, step.files);
      return {
        output: { schema: 1, summary: id, claims: [], touched: Object.keys(step.files) },
        transcript: id,
        usage,
        exit: "ok",
      };
    },
  };
  return { worker, spawned };
}

/** A gate sandbox that runs commands on the host in the workdir, and tracks join re-gates. */
function sandboxes(onJoinExec?: () => void | Promise<void>) {
  const log = { opened: 0, disposed: 0, joinExecs: 0, inJoin: 0, maxInJoin: 0 };
  const gateSandbox = async (workdir: string): Promise<Sandbox> => {
    log.opened++;
    const isJoin = workdir.includes("-join");
    return {
      kind: "native",
      root: workdir,
      async exec(command) {
        if (isJoin) {
          log.joinExecs++;
          log.inJoin++;
          log.maxInJoin = Math.max(log.maxInJoin, log.inJoin);
          await new Promise((r) => setTimeout(r, 20));
          await onJoinExec?.();
        }
        try {
          return await run(["sh", "-c", command], { cwd: workdir });
        } finally {
          if (isJoin) log.inJoin--;
        }
      },
      readFile: async () => "",
      writeFile: async () => {},
      dispose: async () => void log.disposed++,
    };
  };
  return { gateSandbox, log };
}

async function setup() {
  const repoDir = await initRepo(dir(), {
    "server/go.mod": "module game\n",
    "server/a.txt": "base\n",
  });
  const ledger = openLedger(join(dir(), "node"), { nodeId: "devserver" });
  const worktreesDir = join(dir(), "worktrees");
  const go = (p: Plan, o: Partial<RunPlanOptions> & Pick<RunPlanOptions, "worker" | "config">) =>
    runPlan({
      ledger,
      workspace,
      workspaceRoot: repoDir,
      brief,
      plan: p,
      runId: "R1",
      changesetId: "C1",
      gates: builtinGates(),
      worktreesDir,
      ...o,
    });
  return { repoDir, ledger, worktreesDir, go };
}

const accepted = (ledger: Ledger, unit: string) =>
  ledger.read({ types: ["unit.accepted"] }).some((s) => s.event.unit_id === unit);

const gateResults = (ledger: Ledger, unit: string) =>
  ledger
    .read({ types: ["gate.result"] })
    .filter((s) => s.event.unit_id === unit)
    .map((s) => s.event);

/** T1 finishes first, T2 waits for T1's acceptance, so T2 always joins onto a moved tip. */
function lateT2(ledger: () => Ledger, t1: Record<string, string>, t2: Step["files"][]) {
  const s = scripted({
    T1: [{ files: t1, wait: () => until(() => s.spawned.includes("T2")) }],
    T2: t2.map((files, i) => ({
      files,
      ...(i === 0 ? { wait: () => until(() => accepted(ledger(), "T1")) } : {}),
    })),
  });
  return s;
}

const log = (repoDir: string, args: string[]) =>
  runOk(["git", ...args], { cwd: repoDir }).then((o) => o.split("\n").filter(Boolean));

function filesUnder(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const p = join(root, e);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe("join", () => {
  test("two_independent_units_both_accepted", async () => {
    const { go, ledger, repoDir } = await setup();
    const { gateSandbox, log: sb } = sandboxes();
    const { worker } = lateT2(() => ledger, { "b.txt": "one\n" }, [{ "c.txt": "two\n" }]);
    const p = plan([task("T1", ["b.txt"]), task("T2", ["c.txt"])]);
    const result = await go(p, { worker, config: config(2), gateSandbox });

    expect(result.status).toBe("built");
    expect(accepted(ledger, "T1") && accepted(ledger, "T2")).toBe(true);
    const files = await log(repoDir, ["diff", "--name-only", "main", "heph/R1"]);
    expect(files).toEqual(["server/b.txt", "server/c.txt"]);
    expect(await log(repoDir, ["rev-list", "--merges", "main..heph/R1"])).toEqual([]);
    expect(await log(repoDir, ["rev-list", "main..heph/R1"])).toHaveLength(2);

    expect(gateResults(ledger, "T1")).toHaveLength(6);
    const t2 = gateResults(ledger, "T2");
    expect(t2.map((e) => (e.data as GateResult).gate)).toEqual([
      ...builtinGates().map((g) => g.name),
      "tests",
      "typecheck",
      "lint",
    ]);
    expect(new Set(t2.map((e) => e.attempt))).toEqual(new Set([1]));
    // The join's gate results are part of the verdict, written before the attempt finished.
    const t2Events = ledger
      .read()
      .map((s) => s.event)
      .filter((e) => e.unit_id === "T2");
    const finishedAt = t2Events.findIndex((e) => e.type === "unit.attempt.finished");
    expect(t2Events.slice(finishedAt).some((e) => e.type === "gate.result")).toBe(false);
    // The advance names the tip it found at join time and the replayed commit.
    const intent = ledger
      .read({ types: ["effect.intended"] })
      .map((s) => s.event)
      .find((e) => e.unit_id === "T2");
    const tips = await log(repoDir, ["rev-list", "main..heph/R1"]);
    expect(intent?.data).toMatchObject({ before: tips[1], after: tips[0] });
    expect(sb.opened).toBe(sb.disposed);
    ledger.close();
  });

  test("join_not_regated_when_tip_unchanged", async () => {
    const { go, ledger, worktreesDir } = await setup();
    const { gateSandbox, log: sb } = sandboxes();
    const { worker } = scripted({
      T1: [{ files: { "b.txt": "one\n" } }],
      T2: [{ files: { "c.txt": "two\n" } }],
    });
    let rejoins = 0;
    const local = localRunner({
      worker,
      gates: builtinGates(),
      gateSandbox,
      worktreesDir,
      tools: [],
    });
    const runner: Runner = {
      runAttempt: (req, hooks) => local.runAttempt(req, hooks),
      rejoin: (req) => {
        rejoins++;
        return local.rejoin(req);
      },
    };
    const p = plan([task("T1", ["b.txt"]), task("T2", ["c.txt"])]);
    const result = await go(p, { worker, config: config(1), gateSandbox, runner });

    expect(result.status).toBe("built");
    expect(rejoins).toBe(0);
    expect(sb.joinExecs).toBe(0);
    expect(gateResults(ledger, "T1")).toHaveLength(6);
    expect(gateResults(ledger, "T2")).toHaveLength(6);
    ledger.close();
  });

  test("join_conflict_is_a_red_join_gate", async () => {
    const { go, ledger, repoDir } = await setup();
    const { gateSandbox } = sandboxes();
    // diff_scope is left out, so T2 can edit T1's file and the replay conflicts.
    const gates: UnitGate[] = [testsGate, typecheckGate, lintGate];
    const { worker } = lateT2(() => ledger, { "a.txt": "one\n" }, [
      { "a.txt": "two\n", "c.txt": "two\n" },
      { "c.txt": "two\n" },
    ]);
    const p = plan([task("T1", ["a.txt"]), task("T2", ["c.txt"])]);
    const result = await go(p, { worker, config: config(2), gates, gateSandbox });

    const join_ = gateResults(ledger, "T2").find((e) => (e.data as GateResult).gate === "join");
    expect(join_?.attempt).toBe(1);
    expect(join_?.data).toMatchObject({ verdict: "fail", evidence: ["server/a.txt"] });
    const returned = ledger.read({ types: ["unit.returned"] }).map((s) => s.event);
    expect(returned.map((e) => [e.unit_id, e.attempt])).toEqual([["T2", 1]]);
    const finished = ledger
      .read({ types: ["unit.attempt.finished"] })
      .map((s) => s.event)
      .filter((e) => e.unit_id === "T2");
    expect(finished.map((e) => [e.attempt, (e.data as { outcome: string }).outcome])).toEqual([
      [1, "red"],
      [2, "green"],
    ]);
    // The second attempt starts from T1's work and is accepted.
    expect(result.status).toBe("built");
    expect((await runOk(["git", "show", "heph/R1:server/a.txt"], { cwd: repoDir })).trim()).toBe(
      "one",
    );
    ledger.close();
  });

  test("join_regate_red_returns_the_unit", async () => {
    const { go, ledger } = await setup();
    const { gateSandbox } = sandboxes();
    // Each unit's tests pass alone; together they fail.
    const test = "! { [ -f b.txt ] && [ -f c.txt ]; }";
    const { worker } = lateT2(() => ledger, { "b.txt": "one\n" }, [
      { "c.txt": "two\n" },
      { "c.txt": "two\n" },
      { "c.txt": "two\n" },
    ]);
    const p = plan([task("T1", ["b.txt"]), task("T2", ["c.txt"])]);
    const result = await go(p, { worker, config: config(2, test), gateSandbox });

    expect(accepted(ledger, "T2")).toBe(false);
    const first = ledger
      .read({ types: ["unit.returned"] })
      .map((s) => s.event)
      .find((e) => e.unit_id === "T2" && e.attempt === 1);
    const reasons = (first?.data as { reasons: { gate: string }[] } | undefined)?.reasons ?? [];
    expect(reasons.map((r) => r.gate)).toEqual(["tests"]);
    expect(result.status).toBe("paused");
    ledger.close();
  });

  // Found live: at parallel 2 both chains' test units ran together, leaving two red tests that
  // each blocked the other chain's implement unit ("no unit can start: T2, T4").
  test("two_test_chains_in_one_project_build_at_parallel_2", async () => {
    const { go, ledger } = await setup();
    const { gateSandbox } = sandboxes();
    // The whole suite: every red test needs its green implementation.
    const test =
      'for f in $(find . -name "*.red"); do [ -f "$(dirname $f)/$(basename $f .red).green" ] || exit 1; done';
    const { worker, spawned } = scripted({
      T1: [{ files: { "ac1.red": "x\n" } }],
      T2: [{ files: { "ac1.green": "x\n" } }],
      T3: [{ files: { "ac2.red": "x\n" } }],
      T4: [{ files: { "ac2.green": "x\n" } }],
    });
    const chain = (t: string, i: string, ac: string): Task[] => [
      { ...task(t, [`${ac.toLowerCase()}.red`]), kind: "test", covers: [ac], produces: [t] },
      { ...task(i, [`${ac.toLowerCase()}.green`]), covers: [ac], consumes: [t] },
    ];
    const p = plan([...chain("T1", "T2", "AC1"), ...chain("T3", "T4", "AC2")]);
    const result = await go(p, { worker, config: config(2, test), gateSandbox });

    expect(result.status).toBe("built");
    expect(["T1", "T2", "T3", "T4"].every((id) => accepted(ledger, id))).toBe(true);
    expect(spawned).toEqual(["T1", "T2", "T3", "T4"]);
    ledger.close();
  });

  test("lock_serializes_advances", async () => {
    const { go, ledger, repoDir } = await setup();
    const { gateSandbox, log: sb } = sandboxes();
    const ids = ["T1", "T2", "T3"];
    const s = scripted(
      Object.fromEntries(
        ids.map((id) => [
          id,
          [
            {
              files: { [`${id}.txt`]: `${id}\n` },
              wait: () => until(() => ids.every((i) => s.spawned.includes(i))),
            },
          ],
        ]),
      ),
    );
    const p = plan(ids.map((id) => task(id, [`${id}.txt`])));
    const result = await go(p, { worker: s.worker, config: config(3), gateSandbox });

    expect(result.status).toBe("built");
    expect(ids.every((id) => accepted(ledger, id))).toBe(true);
    expect(sb.joinExecs).toBeGreaterThan(0);
    expect(sb.maxInJoin).toBe(1);
    expect(await log(repoDir, ["rev-list", "main..heph/R1"])).toHaveLength(3);
    expect(await log(repoDir, ["rev-list", "--merges", "main..heph/R1"])).toEqual([]);
    ledger.close();
  });

  test("joinLocks runs one function at a time per repo, repos independently", async () => {
    const lock = joinLocks();
    const order: string[] = [];
    const step = (name: string, ms: number) => async () => {
      order.push(`${name}+`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}-`);
      return name;
    };
    const failing = lock("a", async () => {
      throw new Error("boom");
    });
    const out = await Promise.all([
      lock("a", step("a1", 20)),
      lock("a", step("a2", 1)),
      lock("b", step("b1", 5)),
      failing.catch((e) => String(e)),
    ]);
    expect(out).toEqual(["a1", "a2", "b1", "Error: boom"]);
    const a = order.filter((o) => o.startsWith("a"));
    expect(a).toEqual(["a1+", "a1-", "a2+", "a2-"]);
    expect(order.indexOf("b1+")).toBeLessThan(order.indexOf("a1-"));
  });

  test("abort_during_join_leaves_nothing", async () => {
    const { go, ledger, repoDir, worktreesDir } = await setup();
    const abort = new AbortController();
    const { gateSandbox, log: sb } = sandboxes(() => abort.abort());
    const { worker } = lateT2(() => ledger, { "b.txt": "one\n" }, [{ "c.txt": "two\n" }]);
    const p = plan([task("T1", ["b.txt"]), task("T2", ["c.txt"])]);
    const result = await go(p, {
      worker,
      config: config(2),
      gateSandbox,
      signal: abort.signal,
    });

    expect(sb.joinExecs).toBeGreaterThan(0);
    expect(result.status).toBe("paused");
    expect(ledger.run("R1")?.status).toBe("paused");
    expect(accepted(ledger, "T1")).toBe(true);
    expect(accepted(ledger, "T2")).toBe(false);
    const t2 = ledger
      .read()
      .map((s) => s.event)
      .filter((e) => e.unit_id === "T2")
      .map((e) => e.type);
    expect(t2.at(-1)).toBe("unit.attempt.interrupted");
    expect(t2).not.toContain("unit.attempt.finished");
    expect(filesUnder(join(worktreesDir, "R1"))).toEqual([]);
    expect(await log(repoDir, ["worktree", "list"])).toHaveLength(1);
    expect(sb.opened).toBe(sb.disposed);
    expect(pendingEffects(ledger, "R1")).toEqual([]);
    expect(
      await reconcile(
        ledger,
        "R1",
        realityOf({}, () => repoDir),
      ),
    ).toEqual([]);
    expect(await log(repoDir, ["rev-list", "main..heph/R1"])).toHaveLength(1);
    ledger.close();
  });
});

describe("rejoin cleanup", () => {
  test("a join worktree that fails to be added is still cleaned up", async () => {
    const { repoDir, worktreesDir } = await setup();
    const main = (await log(repoDir, ["rev-parse", "main"]))[0] as string;
    const path = join(worktreesDir, "R1", "T1", "a1-join");
    // A failing post-checkout hook: git creates and registers the worktree, then fails the add.
    const hooks = join(dir(), "hooks");
    writeFiles(hooks, { "post-checkout": "#!/bin/sh\nexit 1\n" });
    await runOk(["chmod", "+x", join(hooks, "post-checkout")]);
    await runOk(["git", "config", "core.hooksPath", hooks], { cwd: repoDir });
    const runner = localRunner({
      worker: scripted({}).worker,
      gates: [],
      worktreesDir,
      tools: [],
    });
    await expect(
      runner.rejoin({
        runId: "R1",
        task: task("T1", ["b.txt"]),
        attempt: 1,
        repoDir,
        projectPath: "server",
        project: { name: "server", stack: "go", commands: {} },
        locked: [],
        commit: main,
        tip: main,
        worker: { schema: 1, summary: "", claims: [], touched: [] },
      }),
    ).rejects.toThrow("worktree add");
    expect(await log(repoDir, ["worktree", "list"])).toHaveLength(1);
    expect(filesUnder(path)).toEqual([]);
  });
});

describe("the joined commit is pinned", () => {
  const ref = "refs/heph/join/R1/T2-a1";
  const refSha = async (repoDir: string, r: string) =>
    (await run(["git", "rev-parse", "--verify", "--quiet", r], { cwd: repoDir })).stdout.trim() ||
    undefined;
  const advanceIntent = (ledger: Ledger) =>
    ledger
      .read({ types: ["effect.intended"] })
      .map((s) => s.event)
      .find(
        (e) => e.unit_id === "T2" && (e.data as { effect: string }).effect === "run_branch_advance",
      )?.data as { after: string } | undefined;

  test("a ref holds the replayed commit from before its advance until the unit is accepted", async () => {
    const { go, ledger, repoDir } = await setup();
    const { worker } = lateT2(() => ledger, { "b.txt": "one\n" }, [{ "c.txt": "two\n" }]);
    const p = plan([task("T1", ["b.txt"]), task("T2", ["c.txt"])]);
    let pinned: string | undefined;
    const result = await go(p, {
      worker,
      config: config(2),
      gates: [],
      chaos: async (point) => {
        if (point === "before:run_branch_advance:game:T2:a1") pinned = await refSha(repoDir, ref);
      },
    });
    expect(result.status).toBe("built");
    expect(pinned).toBeDefined();
    expect(pinned).toBe(advanceIntent(ledger)?.after);
    expect(await refSha(repoDir, ref)).toBeUndefined();
    ledger.close();
  });

  test("killed between the advance's intent and the move, resume applies it and drops the ref", async () => {
    const { go, ledger, repoDir, worktreesDir } = await setup();
    const { worker } = lateT2(() => ledger, { "b.txt": "one\n" }, [{ "c.txt": "two\n" }]);
    const p = plan([task("T1", ["b.txt"]), task("T2", ["c.txt"])]);
    await expect(
      go(p, {
        worker,
        config: config(2),
        gates: [],
        chaos: (point) => {
          if (point === "before:run_branch_advance:game:T2:a1") throw new Stopped("killed");
        },
      }),
    ).rejects.toBeInstanceOf(Stopped);
    const after = advanceIntent(ledger)?.after as string;
    expect(await refSha(repoDir, ref)).toBe(after);
    // Nothing else holds the replayed commit: a gc here would lose it without the ref.
    expect(await refSha(repoDir, "heph/R1")).not.toBe(after);

    const out = await buildRun({
      ledger,
      workspace,
      workspaceRoot: repoDir,
      runId: "R1",
      changesetId: "C1",
      gates: [],
      worktreesDir,
      worker,
      config: config(2),
    });
    expect(out.status).toBe("built");
    expect(await refSha(repoDir, "heph/R1")).toBe(after);
    expect(await refSha(repoDir, ref)).toBeUndefined();
    expect(await log(repoDir, ["for-each-ref", "refs/heph/join/"])).toEqual([]);
    ledger.close();
  });
});

describe("rate-limit throttle", () => {
  test("a build resuming from a rate limit starts at half its parallelism and ramps up", async () => {
    const { go, ledger, repoDir, worktreesDir } = await setup();
    let limited = true;
    let inFlight = 0;
    const spawned: string[] = [];
    const overlap = new Map<string, number>();
    const worker: Worker = {
      async spawn(input: SpawnInput) {
        const id = input.brief.task.id;
        spawned.push(id);
        inFlight++;
        try {
          if (limited) {
            await until(() => spawned.length >= 3);
            return { output: undefined, transcript: "", usage, exit: "rate_limited" };
          }
          // T1 runs a while; T2 and T3 hold on until both are in flight.
          if (id === "T1") await new Promise((r) => setTimeout(r, 60));
          if (id === "T2") await until(() => spawned.includes("T3"));
          overlap.set(id, Math.max(overlap.get(id) ?? 0, inFlight));
          if (id === "T3") await until(() => overlap.has("T2"));
          const file = `${id.toLowerCase()}.txt`;
          writeFiles(input.workdir, { [file]: `${id}\n` });
          return {
            output: { schema: 1, summary: id, claims: [], touched: [file] },
            transcript: id,
            usage,
            exit: "ok",
          };
        } finally {
          inFlight--;
        }
      },
    };
    const ids = ["T1", "T2", "T3", "T4"];
    const p = plan(ids.map((id) => task(id, [`${id.toLowerCase()}.txt`])));
    const first = await go(p, { worker, config: config(3), gates: [] });
    expect(first.status).toBe("paused");
    // Unthrottled: three at once.
    expect(spawned.toSorted()).toEqual(["T1", "T2", "T3"]);
    expect(ledger.read({ types: ["run.paused"] }).at(-1)?.event.data).toMatchObject({
      reason: "rate_limit",
    });

    limited = false;
    spawned.length = 0;
    const second = await buildRun({
      ledger,
      workspace,
      workspaceRoot: repoDir,
      runId: "R1",
      changesetId: "C1",
      gates: [],
      worktreesDir,
      worker,
      config: config(3),
    });
    expect(second.status).toBe("built");
    expect(ledger.read({ types: ["run.resumed"] }).at(-1)?.event.data).toEqual({
      reason: "rate_limit",
    });
    // floor(3 / 2) = 1: T1 alone; one accepted, 2: T2 and T3 together; then up to 3.
    expect(spawned[0]).toBe("T1");
    expect(overlap.get("T1")).toBe(1);
    expect(overlap.get("T2")).toBe(2);
    expect(spawned.toSorted()).toEqual(ids);
    for (const id of ids) expect(accepted(ledger, id)).toBe(true);
    ledger.close();
  });
});

describe("a simulated kill in a parallel unit", () => {
  test("propagates at once; a unit still in flight writes nothing after it", async () => {
    const { go, ledger, repoDir } = await setup();
    let killedAt = -1;
    let release!: () => void;
    const t2Done = new Promise<void>((r) => {
      release = r;
    });
    const spawned: string[] = [];
    const worker: Worker = {
      async spawn(input: SpawnInput) {
        const id = input.brief.task.id;
        spawned.push(id);
        if (id === "T1") {
          await until(() => spawned.includes("T2"));
          killedAt = ledger.read().length;
          throw new Stopped("killed in T1");
        }
        // T2 is slow: it finishes green well after T1's kill.
        await until(() => killedAt >= 0);
        await new Promise((r) => setTimeout(r, 50));
        writeFiles(input.workdir, { "c.txt": "two\n" });
        setTimeout(release, 200);
        return {
          output: { schema: 1, summary: id, claims: [], touched: ["c.txt"] },
          transcript: id,
          usage,
          exit: "ok",
        };
      },
    };
    const p = plan([task("T1", ["b.txt"]), task("T2", ["c.txt"])]);
    await expect(go(p, { worker, config: config(2), gates: [] })).rejects.toBeInstanceOf(Stopped);
    // Rejected before T2 finished its attempt.
    expect(spawned.toSorted()).toEqual(["T1", "T2"]);
    expect(accepted(ledger, "T2")).toBe(false);
    await t2Done;
    const after = ledger
      .read()
      .slice(killedAt)
      .map((s) => s.event);
    expect(after.filter((e) => e.unit_id === "T2").map((e) => e.type)).toEqual([]);
    expect(accepted(ledger, "T2")).toBe(false);
    expect(await log(repoDir, ["rev-list", "main..heph/R1"])).toEqual([]);
    ledger.close();
  });
});
