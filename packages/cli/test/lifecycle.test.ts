import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type SpawnInput, type SpawnOutput, Stopped, type Worker } from "@hephaestus/engine";
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

    const refused = await heph(["run", "R1"], deps);
    expect(refused).toMatchObject({
      ok: false,
      code: 1,
      error: { message: "the latest plan of R1 is not approved (heph approve plan R1)" },
    });

    expect((await heph(["approve", "plan", "R1"], deps)).ok).toBe(true);
    expect((await heph(["plan", "show", "R1"], deps)).data).toMatchObject({ approved: true });

    const built = await heph(["run", "R1"], deps);
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

  test("an invalid plan is retried with the gate evidence, then the run fails", async () => {
    await initWithTests();
    const noTest = JSON.stringify({ schema: 1, tasks: [JSON.parse(PLAN).tasks[1]], risks: [] });
    const p = planner([noTest, noTest, noTest]);
    const r = await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R3"], {
      planner: p.fn,
    });
    expect(r.data).toMatchObject({ status: "failed", planner_attempts: 3 });
    expect(p.prompts).toHaveLength(3);
    expect(p.prompts[1]).toContain("Your previous answer failed these checks");
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
    await heph(["run", "R4"], deps);
    const t2 = inputs.find((i) => i.brief.task.id === "T2");
    expect(t2?.brief.constraints).toContain("Hint from the user: use shell arithmetic");
    expect(t2?.brief.context.budget_tokens).toBe(5000);

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

  test("errors use the envelope", async () => {
    const r = await heph(["status", "nope"]);
    expect(r).toMatchObject({
      ok: false,
      code: 1,
      command: "status",
      error: { message: "no run nope" },
    });
  });
});
