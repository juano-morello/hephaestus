import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadSuite, type Suite } from "@hephaestus/core";
import type { SpawnInput, SpawnOutput, Worker } from "@hephaestus/engine";
import { openLedger } from "@hephaestus/ledger";
import { run as procRun, type Sandbox, type SandboxSpec } from "@hephaestus/sandbox";
import { type PlannerInput, type PlannerSession, runPlanner } from "@hephaestus/workers";
import { readResults, resultExists } from "../src/eval/results.ts";
import { runEval, runEvalTask } from "../src/eval/run.ts";
import type { Deps } from "../src/runtime.ts";

let root: string;
let real: string;
let suiteDir: string;
let realHome: string;
let evalHome: string;
let pin: string;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@x", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

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
      creates: ["test_add.sh"],
      produces: ["test:Add"],
      spec: "write test_add.sh",
    }),
    task({
      id: "T2",
      title: "impl",
      kind: "implement",
      scope: ["add.sh"],
      creates: ["add.sh"],
      consumes: ["test:Add"],
      spec: "write add.sh",
    }),
  ],
  risks: [],
});
const ESCALATE = JSON.stringify({ schema: 1, escalate: ["AC1 contradicts decision 1"] });

/** The real planner on a fake session that answers with the next scripted reply. */
function planner(replies: string[]) {
  const calls = { n: 0 };
  const fn = (input: PlannerInput) => {
    calls.n++;
    return runPlanner({
      ...input,
      createSession: async () => {
        const text = (replies.length > 1 ? replies.shift() : replies[0]) ?? "";
        const session: PlannerSession = {
          async prompt() {
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
  };
  return { fn, calls };
}

const FILES: Record<string, Record<string, string>> = {
  T1: { "test_add.sh": '[ "$(sh add.sh 2 3)" = "5" ]\n' },
  T2: { "add.sh": "echo $(($1 + $2))\n" },
};
function worker() {
  const calls = { n: 0 };
  const w: Worker = {
    async spawn(input: SpawnInput): Promise<SpawnOutput> {
      calls.n++;
      const files = FILES[input.brief.task.id] ?? {};
      for (const [p, c] of Object.entries(files)) put(join(input.workdir, p), c);
      return {
        output: { schema: 1, summary: "", claims: [], touched: Object.keys(files) },
        transcript: "",
        usage: { input: 10, output: 20, cache_read: 0, cache_write: 0 },
        exit: "ok",
      };
    },
  };
  return { w, calls };
}

/** Runs commands on the host in the directory, with no confinement: the native sandbox cannot nest here. */
async function plainSandbox(hostDir: string): Promise<Sandbox> {
  return {
    kind: "native",
    root: hostDir,
    exec: (command, opts) =>
      procRun(["sh", "-c", command], {
        cwd: opts?.cwd ? join(hostDir, opts.cwd) : hostDir,
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      }),
    async readFile(p) {
      return readFileSync(join(hostDir, p), "utf8");
    },
    async writeFile(p, c) {
      put(join(hostDir, p), c);
    },
    async dispose() {},
  };
}
const sandbox = (spec: SandboxSpec) => plainSandbox(spec.hostDir);

const evalYaml = (id: string, body: string, tags: string[] = []) =>
  `id: ${id}\nworkspace_ref: { calc: "${pin}" }\nbrief: ../briefs/b.yaml\n${body}\ntags: [${tags.join(", ")}]\n`;
const oracleYaml = (check: string, extra = "") =>
  `oracle:\n  hidden_tests:\n    - { project: calc, from: ./oracle/${check}, to: check.sh }\n  must_pass:\n    - { project: calc, run: sh check.sh }\n${extra}`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heph-evrun-"));
  real = join(root, "calc");
  suiteDir = join(root, "suite");
  realHome = join(root, "real-home");
  evalHome = join(root, "eval-home");
  put(join(real, "README.md"), "# calc\n");
  git(real, "init", "-q", "-b", "main");
  git(real, "add", "-A");
  git(real, "commit", "-qm", "base");
  pin = git(real, "rev-parse", "HEAD");
  git(real, "remote", "add", "origin", join(root, "nowhere.git"));
  // Uncommitted, like a developer's checkout.
  put(
    join(real, ".heph", "config.yaml"),
    "projects:\n  calc:\n    commands: { test: sh test_add.sh }\n",
  );
  put(join(realHome, "config.yaml"), "node: { id: eval-test }\nsandbox: { mode: native }\n");
  put(
    join(suiteDir, "workspace.yaml"),
    "repos: { calc: ../calc }\nprojects:\n  calc: { repo: calc, path: ., stack: sh }\n",
  );
  put(join(suiteDir, "gates.yaml"), "calc: [tests]\n");
  put(join(suiteDir, "briefs", "b.yaml"), BRIEF);
  put(join(suiteDir, "evals", "oracle", "good.sh"), '[ "$(sh add.sh 7 8)" = "15" ]\n');
  put(join(suiteDir, "evals", "oracle", "bad.sh"), '[ "$(sh add.sh 7 8)" = "99" ]\n');
  put(join(suiteDir, "briefs", "b.yaml"), BRIEF);
  put(join(suiteDir, "evals", "solve.yaml"), evalYaml("solve", oracleYaml("good.sh"), ["fast"]));
  put(
    join(suiteDir, "evals", "unsolved.yaml"),
    evalYaml("unsolved", oracleYaml("bad.sh"), ["slow"]),
  );
  put(
    join(suiteDir, "evals", "forbid.yaml"),
    evalYaml(
      "forbid",
      oracleYaml("good.sh", "  must_not_touch:\n    - { project: calc, paths: [add.sh] }\n"),
    ),
  );
  put(
    join(suiteDir, "evals", "should-escalate.yaml"),
    evalYaml("should-escalate", "expect: escalate", ["esc"]),
  );
  put(join(suiteDir, "evals", "todo.yaml"), evalYaml("todo", oracleYaml("missing.sh")));
  put(join(suiteDir, "evals", "broken.yaml"), "id: broken\nnonsense: true\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const snapshot = () => ({
  head: git(real, "rev-parse", "HEAD"),
  refs: git(real, "for-each-ref"),
  status: git(real, "status", "--porcelain"),
  remotes: git(real, "remote"),
});

async function suiteAndTask(id: string) {
  const suite = await loadSuite(suiteDir);
  const entry = suite.tasks.find((t) => t.task?.id === id);
  if (!entry) throw new Error(`no task ${id}`);
  return { suite, entry };
}

async function one(id: string, deps: Deps, k = 1) {
  const { suite, entry } = await suiteAndTask(id);
  let clock = 0;
  return runEvalTask({
    suite,
    entry,
    run: k,
    label: "L",
    evalHome,
    realHome,
    deps: { sandbox, ...deps },
    sandboxOf: async (_config, hostDir) => plainSandbox(hostDir),
    now: () => {
      clock += 100;
      return clock;
    },
  });
}

describe("runEvalTask", () => {
  test("a plannable task whose oracle passes is solved, with metrics", async () => {
    const w = worker();
    const r = await one("solve", { planner: planner([PLAN]).fn, worker: w.w });
    expect(r).toMatchObject({
      schema: 1,
      task: "solve",
      run: 1,
      label: "L",
      status: "solved",
      solved: true,
      failures: [],
    });
    expect(r.metrics).toMatchObject({
      first_pass_valid: true,
      units: 2,
      attempts: 2,
      attempts_per_unit: 1,
      escalations: 0,
      stalls: 0,
      scope_violations: 0,
      wall_ms: 100,
    });
    expect(r.metrics?.tokens).toBe(60);
    expect(w.calls.n).toBe(2);
  });

  test("a failing must_pass is unsolved and names the command", async () => {
    const r = await one("unsolved", { planner: planner([PLAN]).fn, worker: worker().w });
    expect(r.status).toBe("unsolved");
    expect(r.solved).toBe(false);
    expect(r.failures).toEqual(["must_pass calc: sh check.sh exited 1"]);
  });

  test("a changed forbidden path is unsolved and names the file", async () => {
    const r = await one("forbid", { planner: planner([PLAN]).fn, worker: worker().w });
    expect(r.status).toBe("unsolved");
    expect(r.failures).toEqual(["must_not_touch calc: add.sh"]);
  });

  test("an expect: escalate task whose planner escalates is escalated, and solved", async () => {
    const w = worker();
    const r = await one("should-escalate", { planner: planner([ESCALATE]).fn, worker: w.w });
    expect(r).toMatchObject({ status: "escalated", solved: true, failures: [] });
    expect(r.metrics?.attempts).toBe(0);
    expect(w.calls.n).toBe(0);
  });

  test("an expect: escalate task whose planner plans is missed_escalation and is not built", async () => {
    const w = worker();
    const r = await one("should-escalate", { planner: planner([PLAN]).fn, worker: w.w });
    expect(r).toMatchObject({ status: "missed_escalation", solved: false });
    expect(w.calls.n).toBe(0);
    expect(r.metrics?.attempts).toBe(0);
  });

  test("a plannable task whose planner escalates is false_escalation", async () => {
    const w = worker();
    const r = await one("solve", { planner: planner([ESCALATE]).fn, worker: w.w });
    expect(r).toMatchObject({ status: "false_escalation", solved: false });
    expect(w.calls.n).toBe(0);
  });

  test("a planner that never produces a valid plan is unsolved with the reason", async () => {
    const r = await one("solve", { planner: planner(["not json"]).fn, worker: worker().w });
    expect(r.status).toBe("unsolved");
    expect(r.failures[0]).toContain("no valid plan");
  });

  test("a run that throws is recorded as error with the message", async () => {
    const r = await one("solve", {
      planner: async () => {
        throw new Error("planner exploded");
      },
      worker: worker().w,
    });
    expect(r).toMatchObject({ status: "error", solved: false, error: "planner exploded" });
    expect(r.metrics).toBeUndefined();
  });

  test("the run is flagged eval in a throwaway ledger; the real home and repo see nothing", async () => {
    const before = snapshot();
    const r = await one("solve", { planner: planner([PLAN]).fn, worker: worker().w });
    expect(r.status).toBe("solved");
    const runDir = join(evalHome, "L", "solve", "run-1");
    const ledger = openLedger(join(runDir, "home"), { nodeId: "eval-test" });
    const runs = ledger.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.eval).toBe(true);
    const created = ledger.read({ types: ["run.created"] })[0]?.event.data as { eval: boolean };
    expect(created.eval).toBe(true);
    ledger.close();
    // The real node's ledger got no event.
    const real = openLedger(realHome, { nodeId: "eval-test" });
    expect(real.runs()).toEqual([]);
    expect(real.read({}).length).toBe(0);
    real.close();
    // The real repo is exactly as it was, and the throwaway clone has no remote.
    expect(snapshot()).toEqual(before);
    expect(git(join(runDir, "ws", "calc"), "remote")).toBe("");
  });

  test("an old run directory of the same label, task and index is replaced", async () => {
    const stale = join(evalHome, "L", "solve", "run-1", "ws", "stale.txt");
    put(stale, "x");
    await one("solve", { planner: planner([PLAN]).fn, worker: worker().w });
    expect(existsSync(stale)).toBe(false);
  });
});

async function evalRun(
  o: {
    taskIds?: string[];
    tags?: string[];
    runs?: number;
    resume?: boolean;
    out?: string;
  },
  deps: Deps,
) {
  const suite: Suite = await loadSuite(suiteDir);
  const log: string[] = [];
  const out = o.out ?? join(suiteDir, "results");
  const r = await runEval({
    suite,
    ...(o.taskIds ? { taskIds: o.taskIds } : {}),
    tags: o.tags ?? [],
    runs: o.runs ?? 1,
    label: "L",
    out,
    resume: o.resume ?? false,
    evalHome,
    realHome,
    deps: { sandbox, ...deps },
    sandboxOf: async (_config, hostDir) => plainSandbox(hostDir),
    log: (l) => log.push(l),
  });
  return { ...r, log, out };
}

describe("runEval", () => {
  test("skips needs_oracle and invalid tasks with their reason, and unknown ids", async () => {
    const r = await evalRun(
      { taskIds: ["todo", "broken.yaml", "nope", "should-escalate"] },
      { planner: planner([ESCALATE]).fn, worker: worker().w },
    );
    // The suite's tasks in its order (by file name), then the ids it does not have.
    expect(r.skipped).toEqual([
      { id: "broken.yaml", reason: expect.stringMatching(/^invalid: /) },
      { id: "todo", reason: "needs_oracle" },
      { id: "nope", reason: "unknown task" },
    ]);
    expect(r.results.map((x) => x.task)).toEqual(["should-escalate"]);
  });

  test("with no filter every ready task runs and the others are listed as skipped", async () => {
    const r = await evalRun({}, { planner: planner([PLAN]).fn, worker: worker().w });
    expect(r.results.map((x) => x.task).sort()).toEqual([
      "forbid",
      "should-escalate",
      "solve",
      "unsolved",
    ]);
    expect(r.skipped.map((s) => s.id).sort()).toEqual(["broken.yaml", "todo"].sort());
  });

  test("filters by tag", async () => {
    const r = await evalRun(
      { tags: ["fast"] },
      { planner: planner([PLAN]).fn, worker: worker().w },
    );
    expect(r.results.map((x) => x.task)).toEqual(["solve"]);
    expect(r.skipped).toEqual([]);
    const both = await evalRun(
      { tags: ["fast", "slow"], out: join(root, "out2") },
      { planner: planner([PLAN]).fn, worker: worker().w },
    );
    expect(both.results.map((x) => x.task).sort()).toEqual(["solve", "unsolved"]);
  });

  test("runs: 2 runs each task twice, in order, and writes a file per result as it goes", async () => {
    const r = await evalRun(
      { taskIds: ["solve", "unsolved"], runs: 2 },
      { planner: planner([PLAN]).fn, worker: worker().w },
    );
    expect(r.results.map((x) => `${x.task}#${x.run}`)).toEqual([
      "solve#1",
      "solve#2",
      "unsolved#1",
      "unsolved#2",
    ]);
    expect(r.log).toEqual([
      "solve run 1: solved",
      "solve run 2: solved",
      "unsolved run 1: unsolved",
      "unsolved run 2: unsolved",
    ]);
    for (const x of r.results) expect(resultExists(r.out, "L", x.task, x.run)).toBe(true);
    expect(readResults(r.out, "L")).toHaveLength(4);
    expect(r.summary).toMatchObject({ label: "L", runs: 4, errors: 0 });
    expect(r.summary.overall.solved_rate).toBe(0.5);
  });

  test("an error in one run does not stop the eval", async () => {
    let n = 0;
    const flaky = async (input: PlannerInput) => {
      if (++n === 1) throw new Error("first run explodes");
      return planner([PLAN]).fn(input);
    };
    const r = await evalRun(
      { taskIds: ["solve"], runs: 2 },
      { planner: flaky, worker: worker().w },
    );
    expect(r.results.map((x) => x.status)).toEqual(["error", "solved"]);
    expect(r.summary).toMatchObject({ runs: 2, errors: 1 });
    expect(r.summary.overall.solved_rate).toBe(1);
    expect(readResults(r.out, "L")[0]).toMatchObject({
      status: "error",
      error: "first run explodes",
    });
  });

  test("resume does not rerun a run whose result file exists", async () => {
    const first = planner([PLAN]);
    await evalRun({ taskIds: ["solve"], runs: 2 }, { planner: first.fn, worker: worker().w });
    expect(first.calls.n).toBe(2);
    // Remove run 2 only: run 1 is kept, run 2 is done again.
    rmSync(join(suiteDir, "results", "L", "solve", "run-2.json"));
    const again = planner([PLAN]);
    const r = await evalRun(
      { taskIds: ["solve"], runs: 2, resume: true },
      { planner: again.fn, worker: worker().w },
    );
    expect(again.calls.n).toBe(1);
    expect(r.results.map((x) => `${x.task}#${x.run}:${x.status}`)).toEqual([
      "solve#1:solved",
      "solve#2:solved",
    ]);
    // Everything exists now: nothing runs.
    const none = planner([PLAN]);
    await evalRun(
      { taskIds: ["solve"], runs: 2, resume: true },
      { planner: none.fn, worker: worker().w },
    );
    expect(none.calls.n).toBe(0);
  });

  test("a label that would leave its directory is refused before anything runs", async () => {
    const p = planner([PLAN]);
    const suite = await loadSuite(suiteDir);
    for (const label of ["../escape", "a/b", "..", ""]) {
      await expect(
        runEval({
          suite,
          tags: [],
          runs: 1,
          label,
          out: join(root, "out3"),
          resume: false,
          evalHome,
          realHome,
          deps: { sandbox, planner: p.fn, worker: worker().w },
        }),
      ).rejects.toThrow("label");
    }
    expect(p.calls.n).toBe(0);
    expect(existsSync(join(root, "escape"))).toBe(false);
  });

  test("without resume an existing result is run again", async () => {
    await evalRun({ taskIds: ["solve"] }, { planner: planner([PLAN]).fn, worker: worker().w });
    const again = planner([PLAN]);
    await evalRun({ taskIds: ["solve"] }, { planner: again.fn, worker: worker().w });
    expect(again.calls.n).toBe(1);
  });

  test("the result file holds the whole result", async () => {
    const r = await evalRun(
      { taskIds: ["unsolved"] },
      { planner: planner([PLAN]).fn, worker: worker().w },
    );
    const file = JSON.parse(readFileSync(join(r.out, "L", "unsolved", "run-1.json"), "utf8")) as {
      status: string;
      failures: string[];
    };
    expect(file.status).toBe("unsolved");
    expect(file.failures).toEqual(["must_pass calc: sh check.sh exited 1"]);
  });
});
