import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Brief, briefHash, type Task } from "@hephaestus/core";
import {
  createGit,
  landChangeset,
  type PullRequests,
  runPlan,
  type SpawnInput,
  type SpawnOutput,
  Stopped,
  type Worker,
} from "@hephaestus/engine";
import { openLedger } from "@hephaestus/ledger";
import { type PlannerInput, type PlannerSession, runPlanner } from "@hephaestus/workers";
import type { z } from "zod";
import { type Io, run } from "../src/main.ts";
import { OUTPUT } from "../src/output.ts";
import type { Deps } from "../src/runtime.ts";

let root: string;
let ws: string;
let home: string;

const sh = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};
function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heph-cli-"));
  ws = join(root, "calc");
  home = join(root, "home");
  put(join(ws, "README.md"), "# calc\n");
  sh(["git", "init", "-q", "-b", "main"], ws);
  sh(["git", "-c", "user.name=T", "-c", "user.email=t@x", "add", "-A"], ws);
  sh(["git", "-c", "user.name=T", "-c", "user.email=t@x", "commit", "-qm", "base"], ws);
  // Native sandboxes so the tests need no Docker; the test command is the shell test.
  put(join(home, "config.yaml"), "node: { id: test-node }\nsandbox: { mode: native }\n");
  put(join(root, "brief.yaml"), BRIEF);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const BRIEF = `schema: 1
source: cli
goal: add.sh prints the sum of two integers
context: ""
decisions: [Usage is sh add.sh A B]
constraints: [POSIX sh only]
acceptance:
  - { id: AC1, text: "sh add.sh 2 3 prints 5", kind: behavior }
out_of_scope: []
open_questions: []
`;

const task = (t: Record<string, unknown>) => ({
  lane: "contained",
  complexity: "standard",
  complexity_reason: "small",
  covers: ["AC1"],
  project: "calc",
  ...t,
});
const PLAN = JSON.stringify({
  schema: 1,
  tasks: [
    task({
      id: "T1",
      title: "tests",
      kind: "test",
      scope: ["test_add.sh"],
      produces: ["test:Add"],
      spec: "write test_add.sh",
    }),
    task({
      id: "T2",
      title: "impl",
      kind: "implement",
      scope: ["add.sh"],
      consumes: ["test:Add"],
      spec: "write add.sh",
    }),
  ],
  risks: [],
});

/** The real planner on a fake session that answers with the next scripted reply. */
function planner(replies: string[]) {
  const prompts: string[] = [];
  const fn = (input: PlannerInput) =>
    runPlanner({
      ...input,
      createSession: async () => {
        const text = replies.shift() ?? replies.at(-1) ?? "";
        const session: PlannerSession = {
          async prompt(p) {
            prompts.push(p);
            return true;
          },
          async abort() {},
          getLastAssistantMessage: () => ({
            stopReason: "stop",
            content: [{ type: "text", text }],
          }),
          getSessionStats: () => ({ tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }),
          messages: [],
          async dispose() {},
        };
        return { session };
      },
    });
  return { fn, prompts };
}

const FILES: Record<string, Record<string, string>> = {
  T1: { "test_add.sh": '[ "$(sh add.sh 2 3)" = "5" ]\n' },
  T2: { "add.sh": "echo $(($1 + $2))\n" },
};
function worker(first?: (input: SpawnInput) => Partial<SpawnOutput> | "stop" | undefined) {
  const inputs: SpawnInput[] = [];
  const w: Worker = {
    async spawn(input) {
      inputs.push(input);
      const once = inputs.filter((i) => i.brief.task.id === input.brief.task.id).length === 1;
      const special = once ? first?.(input) : undefined;
      if (special === "stop") throw new Stopped("killed");
      const files = FILES[input.brief.task.id] ?? {};
      for (const [p, c] of Object.entries(files)) put(join(input.workdir, p), c);
      return {
        output: { schema: 1, summary: "", claims: [], touched: Object.keys(files) },
        transcript: "",
        usage: { input: 10, output: 20, cache_read: 0, cache_write: 0 },
        exit: "ok",
        ...special,
      };
    },
  };
  return { w, inputs };
}

type Envelope = {
  schema: number;
  command: string;
  ok: boolean;
  data?: unknown;
  error?: { message: string };
};

async function heph(args: string[], deps: Deps = {}): Promise<Envelope & { code: number }> {
  let out = "";
  const io: Io = {
    cwd: ws,
    env: { HEPH_HOME: home },
    stdout: (s) => {
      out += s;
    },
    stderr: () => {},
    deps,
  };
  const code = await run([...args, "--json"], io);
  const env = JSON.parse(out) as Envelope;
  if (env.ok) {
    const schema = OUTPUT[env.command as keyof typeof OUTPUT] as z.ZodType | undefined;
    expect(schema).toBeDefined();
    schema?.parse(env.data);
  }
  return { ...env, code };
}

/** The planner's answers for a run, in order, as the ledger recorded them. */
async function planAnswers(runId: string) {
  const ledger = openLedger(home, { nodeId: "test-node" });
  try {
    return ledger.read({ run_id: runId, types: ["plan.answer"] }).map(
      (e) =>
        (e as unknown as { event: { data: unknown } }).event.data as {
          attempt: number;
          outcome: string;
          failures: string[];
        },
    );
  } finally {
    ledger.close();
  }
}

async function initWithTests() {
  await heph(["init"]);
  put(
    join(ws, ".heph", "config.yaml"),
    "projects:\n  calc:\n    commands: { test: sh test_add.sh }\n",
  );
}

describe("heph lifecycle", () => {
  test("init, new, plan show, approve, run, status, approve merge", async () => {
    await initWithTests();
    const p = planner([PLAN]);
    const { w } = worker();
    const deps: Deps = { planner: p.fn, worker: w };

    const created = await heph(
      ["new", "feature", "--brief", join(root, "brief.yaml"), "--run-id", "R1"],
      deps,
    );
    expect(created).toMatchObject({
      ok: true,
      data: { run_id: "R1", status: "planned", planner_attempts: 1 },
    });
    expect(p.prompts[0]).toContain("## calc\nREADME.md");

    const shown = await heph(["plan", "show", "R1"], deps);
    expect(shown.data).toMatchObject({ approved: false, order: ["T1", "T2"] });
    // The scope and criteria are what the user reviews a plan by.
    expect((shown.data as { tasks: unknown[] }).tasks[0]).toMatchObject({
      id: "T1",
      scope: ["test_add.sh"],
      covers: ["AC1"],
    });

    // heph run before the approval waits for it (an agent starts it right after showing the
    // plan), then builds.
    let done = false;
    const waiting = heph(["run", "R1"], deps).finally(() => {
      done = true;
    });
    await Bun.sleep(700);
    expect(done).toBe(false);
    expect((await heph(["approve", "plan", "R1"], deps)).ok).toBe(true);
    expect((await heph(["plan", "show", "R1"], deps)).data).toMatchObject({ approved: true });

    const built = await waiting;
    expect(built.data).toMatchObject({ run_id: "R1", status: "staged" });

    const status = await heph(["status", "R1"], deps);
    expect(status.data).toMatchObject({ run: { run_id: "R1", status: "staged" } });
    expect((status.data as { units: { status: string }[] }).units.map((u) => u.status)).toEqual([
      "accepted",
      "accepted",
    ]);

    const merged = await heph(["approve", "merge", "R1"], deps);
    expect(merged.data).toMatchObject({ result: { status: "merged" } });
    expect(sh(["git", "show", "main:add.sh"], ws)).toBe("echo $(($1 + $2))\n");
    expect(
      ((await heph(["status", "R1"], deps)).data as { run: { status: string } }).run.status,
    ).toBe("finished");

    const list = await heph(["status"], deps);
    expect((list.data as { runs: { run_id: string }[] }).runs.map((r) => r.run_id)).toEqual(["R1"]);

    const explained = await heph(["explain", "R1", "T2"], deps);
    const types = (explained.data as { events: { type: string }[] }).events.map((e) => e.type);
    expect(types).toContain("gate.result");
    expect(types).toContain("unit.accepted");
  });

  test("an escalation is reported with its reasons", async () => {
    await initWithTests();
    const r = await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R2"], {
      planner: planner([JSON.stringify({ schema: 1, escalate: ["AC1 contradicts decision 1"] })])
        .fn,
    });
    expect(r.data).toMatchObject({ status: "escalated", escalate: ["AC1 contradicts decision 1"] });
  });

  test("an invalid plan gets one correction with its own output and the gate evidence, then the run fails", async () => {
    await initWithTests();
    const noTest = JSON.stringify({ schema: 1, tasks: [JSON.parse(PLAN).tasks[1]], risks: [] });
    const p = planner([noTest, noTest, noTest]);
    const r = await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R3"], {
      planner: p.fn,
    });
    expect(r.data).toMatchObject({ status: "failed", planner_attempts: 2 });
    expect(p.prompts).toHaveLength(2);
    expect(p.prompts[1]).toContain("Your previous answer failed these checks");
    expect(p.prompts[1]).toContain(noTest);
    expect(await planAnswers("R3")).toMatchObject([
      { attempt: 1, outcome: "invalid" },
      { attempt: 2, outcome: "invalid" },
    ]);
  });

  test("the correction can fix the plan; the answers are recorded by attempt", async () => {
    await initWithTests();
    const noTest = JSON.stringify({ schema: 1, tasks: [JSON.parse(PLAN).tasks[1]], risks: [] });
    const p = planner([noTest, PLAN]);
    const r = await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R3b"], {
      planner: p.fn,
    });
    expect(r.data).toMatchObject({ status: "planned", planner_attempts: 2 });
    const answers = await planAnswers("R3b");
    expect(answers).toMatchObject([
      { attempt: 1, outcome: "invalid" },
      { attempt: 2, outcome: "valid", failures: [] },
    ]);
    expect(answers[0]?.failures.length).toBeGreaterThan(0);
  });

  test("a first-try valid plan records one valid answer and an escalation on the correction is honored", async () => {
    await initWithTests();
    const noTest = JSON.stringify({ schema: 1, tasks: [JSON.parse(PLAN).tasks[1]], risks: [] });
    const esc = JSON.stringify({ schema: 1, escalate: ["AC1 contradicts decision 1"] });
    const r = await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R3c"], {
      planner: planner([noTest, esc]).fn,
    });
    expect(r.data).toMatchObject({ status: "escalated", planner_attempts: 2 });
    expect(await planAnswers("R3c")).toMatchObject([
      { attempt: 1, outcome: "invalid" },
      { attempt: 2, outcome: "escalated" },
    ]);
    const ok = await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R3d"], {
      planner: planner([PLAN]).fn,
    });
    expect(ok.data).toMatchObject({ planner_attempts: 1 });
    expect(await planAnswers("R3d")).toMatchObject([{ attempt: 1, outcome: "valid" }]);
  });

  test("a revision resets the approval; hints reach the next attempt; cancel stops the run", async () => {
    await initWithTests();
    const p = planner([PLAN, PLAN]);
    const { w, inputs } = worker();
    const deps: Deps = { planner: p.fn, worker: w };
    await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R4"], deps);
    await heph(["approve", "plan", "R4"], deps);
    const revised = await heph(["plan", "revise", "R4", "keep it to one line"], deps);
    expect(revised.data).toMatchObject({ status: "planned" });
    expect(p.prompts[1]).toContain("keep it to one line");
    expect((await heph(["plan", "show", "R4"], deps)).data).toMatchObject({ approved: false });

    await heph(["approve", "plan", "R4"], deps);
    await heph(["hint", "R4", "T2", "use shell arithmetic", "--budget", "5000"], deps);
    const widened = await heph([
      "hint",
      "R4",
      "T2",
      "--scope",
      "NOTES.md",
      "--scope",
      "./doc/*.md",
    ]);
    expect(widened.data).toMatchObject({ recorded: ["scope"], scope: ["NOTES.md", "doc/*.md"] });
    for (const bad of ["../x", "/etc/passwd", "**"])
      expect((await heph(["hint", "R4", "T2", "--scope", bad])).error?.message).toContain(bad);
    expect((await heph(["hint", "R4", "T2"])).error?.message).toBe(
      "say something: a hint text, --scope or --budget",
    );
    await heph(["run", "R4"], deps);
    const t2 = inputs.find((i) => i.brief.task.id === "T2");
    expect(t2?.brief.constraints).toContain("Hint from the user: use shell arithmetic");
    expect(t2?.brief.context.budget_tokens).toBe(5000);
    expect(t2?.brief.task.scope).toEqual(["add.sh", "NOTES.md", "doc/*.md"]);

    const p5 = planner([PLAN]);
    await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R5"], { planner: p5.fn });
    expect((await heph(["cancel", "R5"])).data).toMatchObject({ run_id: "R5", status: "failed" });
    await heph(["approve", "plan", "R5"]);
    expect((await heph(["run", "R5"], { worker: w })).error?.message).toBe("run R5 is failed");
  });

  async function approved(runId: string, deps: Deps) {
    await initWithTests();
    await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", runId], deps);
    await heph(["approve", "plan", runId], deps);
  }
  const ids = (inputs: SpawnInput[]) => inputs.map((i) => i.brief.task.id);

  test("a run whose process was stopped mid-build resumes without redoing accepted units", async () => {
    const stopped = worker((i) => (i.brief.task.id === "T2" ? "stop" : undefined));
    await approved("R6", { planner: planner([PLAN]).fn, worker: stopped.w });
    const killed = await heph(["run", "R6"], { worker: stopped.w });
    expect(killed).toMatchObject({ ok: false, error: { message: "killed" } });
    expect(((await heph(["status", "R6"])).data as { run: { status: string } }).run.status).toBe(
      "running",
    );

    const next = worker();
    expect((await heph(["run", "R6"], { worker: next.w })).data).toMatchObject({
      status: "staged",
    });
    expect(ids(next.inputs)).toEqual(["T2"]);
    expect(
      (
        (await heph(["explain", "R6"])).data as { events: { type: string; summary: string }[] }
      ).events
        .filter((e) => e.type === "run.resumed")
        .map((e) => e.summary),
    ).toEqual(["run resumed: crash"]);
    expect((await heph(["run", "R6"], { worker: next.w })).error?.message).toBe(
      "run R6 is already staged (heph approve merge R6)",
    );
  });

  test("a rate-limited run waits for retry_after, unless --now", async () => {
    const t0 = Date.parse("2026-11-04T10:00:00.000Z");
    const retry = new Date(t0 + 90_000).toISOString();
    const limited = () =>
      worker((i) =>
        i.brief.task.id === "T2" ? { exit: "rate_limited", retry_after: retry } : undefined,
      );
    const slept: number[] = [];
    const clock: Deps = { now: () => t0, sleep: async (ms) => void slept.push(ms) };

    const a = limited();
    await approved("R7", { planner: planner([PLAN]).fn, worker: a.w });
    expect((await heph(["run", "R7"], { worker: a.w, ...clock })).data).toMatchObject({
      status: "paused",
    });
    expect(slept).toEqual([]);
    const resumed = await heph(["run", "R7"], { worker: a.w, ...clock });
    expect(resumed.data).toMatchObject({ status: "staged", waited_until: retry });
    expect(slept).toEqual([90_000]);

    const b = limited();
    await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R8"], {
      planner: planner([PLAN]).fn,
    });
    await heph(["approve", "plan", "R8"]);
    await heph(["run", "R8"], { worker: b.w, ...clock });
    expect((await heph(["run", "R8", "--now"], { worker: b.w, ...clock })).data).toMatchObject({
      status: "staged",
    });
    expect(slept).toEqual([90_000]);
  });

  test("a second process can't drive a run while the first is alive; a dead one's lock is taken over", async () => {
    const w = worker();
    await approved("R9", { planner: planner([PLAN]).fn, worker: w.w });
    put(join(home, "locks", "R9.lock"), `${process.ppid}\n`);
    expect((await heph(["run", "R9"], { worker: w.w })).error?.message).toBe(
      `run R9 is being driven by process ${process.ppid}`,
    );
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    put(join(home, "locks", "R9.lock"), `${gone.pid}\n`);
    expect((await heph(["run", "R9"], { worker: w.w })).data).toMatchObject({ status: "staged" });
  });

  test("a run whose planner was stopped is planned from the Brief by plan revise", async () => {
    await initWithTests();
    const stop: Deps["planner"] = async () => {
      throw new Stopped("killed");
    };
    expect(
      (
        await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R10"], {
          planner: stop,
        })
      ).error?.message,
    ).toBe("killed");
    expect((await heph(["run", "R10"])).error?.message).toBe(
      "run R10 has no finished plan (heph plan revise R10)",
    );
    const p = planner([PLAN]);
    expect((await heph(["plan", "revise", "R10"], { planner: p.fn })).data).toMatchObject({
      status: "planned",
    });
    expect(p.prompts[0]).not.toContain("keep it");
    expect((await heph(["plan", "revise", "R10"], { planner: p.fn })).error?.message).toBe(
      "missing instructions",
    );
  });

  test("new --stack-on builds on a built parent's branch, and refuses a failed one", async () => {
    await initWithTests();
    // The parent, built straight through the engine (no command gates, so no sandbox needed).
    const parentBrief = Bun.YAML.parse(BRIEF) as Brief;
    const ledger = openLedger(home, { nodeId: "test-node" });
    const config = {
      routing: { implementer: { default: { model: "claude/sonnet" } } },
      maxAttempts: 1,
      parallel: 1,
      budgetTokens: 1000,
      tools: [],
      commands: {},
    };
    const parent = await runPlan({
      ledger,
      workspace: {
        repos: { calc: "." },
        projects: { calc: { repo: "calc", path: ".", stack: "sh" } },
      },
      workspaceRoot: ws,
      brief: parentBrief,
      plan: {
        schema: 1,
        brief_hash: briefHash(parentBrief),
        tasks: [
          task({
            id: "A1",
            title: "a",
            kind: "implement",
            scope: ["only-on-a.txt"],
            spec: "a",
          }) as Task,
        ],
        risks: [],
      },
      runId: "A",
      changesetId: "A",
      worker: {
        async spawn(input) {
          put(join(input.workdir, "only-on-a.txt"), "a\n");
          return {
            output: { schema: 1, summary: "", claims: [], touched: ["only-on-a.txt"] },
            transcript: "",
            usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            exit: "ok",
          };
        },
      },
      gates: [],
      config,
      worktreesDir: join(home, "worktrees"),
    });
    ledger.close();
    expect(parent.status).toBe("built");

    const p = planner([PLAN, PLAN]);
    const stacked = await heph(
      ["new", "--brief", join(root, "brief.yaml"), "--run-id", "B", "--stack-on", "A"],
      { planner: p.fn },
    );
    expect(stacked).toMatchObject({ ok: true, data: { run_id: "B", status: "planned" } });
    // The planner sees the parent's branch, not the checkout.
    expect(p.prompts[0]).toContain("only-on-a.txt");
    expect((await heph(["status", "B"])).data).toMatchObject({
      run: { run_id: "B", stack_on: "A" },
      stack_on: { run_id: "A", status: "built" },
    });
    expect((await heph(["status", "A"])).data).not.toHaveProperty("stack_on");

    // The parent moves on (rebuilt, say): revising the child plans against its current tip.
    const wt = join(root, "a-wt");
    sh(["git", "worktree", "add", "-q", wt, "heph/A"], ws);
    put(join(wt, "later-on-a.txt"), "later\n");
    sh(["git", "add", "-A"], wt);
    sh(["git", "-c", "user.name=T", "-c", "user.email=t@x", "commit", "-qm", "later"], wt);
    sh(["git", "worktree", "remove", wt], ws);
    const again = planner([PLAN]);
    expect(
      (await heph(["plan", "revise", "B", "once more"], { planner: again.fn })).data,
    ).toMatchObject({ status: "planned" });
    expect(again.prompts[0]).toContain("later-on-a.txt");

    await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "F"], {
      planner: planner([PLAN]).fn,
    });
    await heph(["cancel", "F"]);
    const refused = await heph(
      ["new", "--brief", join(root, "brief.yaml"), "--run-id", "G", "--stack-on", "F"],
      { planner: planner([PLAN]).fn },
    );
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toContain("F is failed (cancelled by user)");
    expect((await heph(["status", "G"])).ok).toBe(false);

    const planned = await heph(
      ["new", "--brief", join(root, "brief.yaml"), "--run-id", "H", "--stack-on", "B"],
      { planner: planner([PLAN]).fn },
    );
    expect(planned.error?.message).toContain("B is planned");
    expect(
      (
        await heph(["new", "--brief", join(root, "brief.yaml"), "--stack-on", "A", "--on", "far"], {
          planner: planner([PLAN]).fn,
        })
      ).error?.message,
    ).toContain("runs on test-node");

    // The parent revised back to planned: its branch is no base any more, so planning refuses.
    expect(
      (await heph(["plan", "revise", "A", "redo it"], { planner: planner([PLAN]).fn })).data,
    ).toMatchObject({ status: "planned" });
    const stale = planner([PLAN]);
    expect(
      (await heph(["plan", "revise", "B", "and again"], { planner: stale.fn })).error?.message,
    ).toBe("stacked on A, which is planned: wait for it to be built again, or rebuild this run");
    expect(stale.prompts).toEqual([]);

    // A parent that already landed: a normal run from the target, and the result says so.
    const l2 = openLedger(home, { nodeId: "test-node" });
    l2.append({
      run_id: "A",
      changeset_id: "A",
      config_hash: "x",
      actor: "engine",
      type: "run.finished",
      data: {},
    });
    l2.close();
    const landed = await heph(
      ["new", "--brief", join(root, "brief.yaml"), "--run-id", "C", "--stack-on", "A"],
      { planner: planner([PLAN]).fn },
    );
    expect(landed.data).toMatchObject({ run_id: "C", status: "planned" });
    expect((landed.data as { note?: string }).note).toContain("A already landed");
    expect(
      ((await heph(["status", "C"])).data as { run: { stack_on: unknown } }).run.stack_on,
    ).toBe(null);
  });

  test("approve merge of a parent restacks its staged child onto the target and retargets its PR", async () => {
    await heph(["init"]);
    const origin = join(root, "calc.git");
    sh(["git", "clone", "-q", "--bare", ws, origin], root);
    sh(["git", "remote", "add", "origin", origin], ws);
    const git = createGit(ws);

    // Pull requests on origin: merging fast-forwards its main to the PR head.
    const calls: string[] = [];
    const pulls = new Map<string, { head: string; base: string; state: "open" | "merged" }>();
    const prs: PullRequests = {
      async open({ head, base }) {
        const url = `https://github.com/acme/calc/pull/${pulls.size + 1}`;
        pulls.set(url, { head, base, state: "open" });
        calls.push(`open ${url} ${head}->${base}`);
        return { url };
      },
      async find({ head }) {
        const [url, pr] = [...pulls].find(([, p]) => p.head === head) ?? [];
        return url && pr ? { url, state: pr.state } : undefined;
      },
      async edit() {},
      async setBase({ url, base }) {
        calls.push(`setBase ${url} ${base}`);
        (pulls.get(url) as { base: string }).base = base;
      },
      async status({ url }) {
        const pr = pulls.get(url);
        if (!pr) throw new Error(`no ${url}`);
        const sha = await git.remoteRef("origin", pr.head);
        return {
          state: pr.state,
          base: pr.base,
          ...(pr.state === "merged" && sha ? { mergeCommit: sha } : {}),
        };
      },
      async readiness({ url }) {
        return {
          ready: true,
          head: (await git.remoteRef("origin", pulls.get(url)?.head ?? "")) as string,
        };
      },
      async merge({ url, head }) {
        calls.push(`merge ${url}`);
        sh(["git", "push", "-q", "origin", `${head}:refs/heads/main`], ws);
        (pulls.get(url) as { state: string }).state = "merged";
        return { mergeCommit: head };
      },
    };

    // A, and B stacked on it, built and staged straight through the engine (no command gates,
    // so no sandbox needed), the way heph run would.
    const parentBrief = Bun.YAML.parse(BRIEF) as Brief;
    const ledger = openLedger(home, { nodeId: "test-node" });
    const config = {
      routing: { implementer: { default: { model: "claude/sonnet" } } },
      maxAttempts: 1,
      parallel: 1,
      budgetTokens: 1000,
      tools: [],
      commands: {},
    };
    const one = (runId: string, file: string, stackOn?: string) => {
      const o = {
        ledger,
        workspace: {
          repos: { calc: "." },
          projects: { calc: { repo: "calc", path: ".", stack: "sh" } },
        },
        workspaceRoot: ws,
        brief: parentBrief,
        plan: {
          schema: 1 as const,
          brief_hash: briefHash(parentBrief),
          tasks: [
            task({
              id: `${runId}1`,
              title: runId,
              kind: "implement",
              scope: [file],
              spec: runId,
            }) as Task,
          ],
          risks: [],
        },
        runId,
        changesetId: runId,
        worker: {
          async spawn(input: SpawnInput) {
            put(join(input.workdir, file), `${runId}\n`);
            return {
              output: { schema: 1 as const, summary: "", claims: [], touched: [file] },
              transcript: "",
              usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
              exit: "ok" as const,
            };
          },
        },
        gates: [],
        config,
        worktreesDir: join(home, "worktrees"),
        prs,
        ...(stackOn ? { stackOn } : {}),
      };
      return o;
    };
    for (const [id, file, on] of [
      ["A", "a.txt"],
      ["B", "b.txt", "A"],
    ] as const) {
      const o = one(id, file, on);
      expect((await runPlan(o)).status).toBe("built");
      expect((await landChangeset(o)).status).toBe("staged");
    }
    ledger.close();
    expect(calls).toEqual([
      "open https://github.com/acme/calc/pull/1 heph/A->main",
      "open https://github.com/acme/calc/pull/2 heph/B->heph/A",
    ]);

    const merged = await heph(["approve", "merge", "A"], { prs });
    expect(merged.data).toMatchObject({
      run_id: "A",
      result: { status: "merged" },
      restacked: { B: { status: "staged" } },
    });
    expect(calls.slice(2)).toEqual([
      "merge https://github.com/acme/calc/pull/1",
      "setBase https://github.com/acme/calc/pull/2 main",
    ]);

    const status = await heph(["status", "B"], { prs });
    expect(status.data).toMatchObject({
      run: { run_id: "B", status: "staged" },
      prs: { calc: "https://github.com/acme/calc/pull/2" },
      stack_on: { run_id: "A", status: "finished" },
    });
    expect(pulls.get("https://github.com/acme/calc/pull/2")?.base).toBe("main");
    const main = (await git.remoteRef("origin", "main")) as string;
    const bTip = (await git.remoteRef("origin", "heph/B")) as string;
    expect(await git.isAncestor(main, bTip)).toBe(true);
    expect(
      sh(["git", "log", "--format=%s", `${main}..${bTip}`], ws)
        .trim()
        .split("\n"),
    ).toHaveLength(1);

    // B was not merged: that still waits for its own approval, which now goes through.
    expect(calls.filter((c) => c.startsWith("merge"))).toHaveLength(1);
    expect(await heph(["approve", "merge", "B"], { prs })).toMatchObject({
      data: { result: { status: "merged" } },
    });
  });

  test("errors use the envelope", async () => {
    const r = await heph(["status", "nope"]);
    expect(r).toMatchObject({
      ok: false,
      code: 1,
      command: "status",
      error: { message: "no run nope on test-node (heph sync?)" },
    });
  });
});
