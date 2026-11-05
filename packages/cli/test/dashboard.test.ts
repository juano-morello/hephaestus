import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type SpawnInput, type SpawnOutput, Stopped, type Worker } from "@hephaestus/engine";
import { type PlannerInput, type PlannerSession, runPlanner } from "@hephaestus/workers";
import { loadConfig } from "../src/config.ts";
import { type Io, run } from "../src/main.ts";
import { Dashboard } from "../src/output.ts";
import { type Deps, openRuntime } from "../src/runtime.ts";

let root: string;
let ws: string;
let home: string;

const sh = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
};
function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heph-dash-"));
  ws = join(root, "calc");
  home = join(root, "home");
  put(join(ws, "README.md"), "# calc\n");
  sh(["git", "init", "-q", "-b", "main"], ws);
  sh(["git", "-c", "user.name=T", "-c", "user.email=t@x", "add", "-A"], ws);
  sh(["git", "-c", "user.name=T", "-c", "user.email=t@x", "commit", "-qm", "base"], ws);
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
const T1 = task({
  id: "T1",
  title: "tests",
  kind: "test",
  scope: ["test_add.sh"],
  produces: ["test:Add"],
  spec: "write test_add.sh",
});
const IMPL = (id: string) =>
  task({
    id,
    title: "impl",
    kind: "implement",
    scope: ["add.sh"],
    consumes: ["test:Add"],
    spec: "write add.sh",
  });
const plan = (...tasks: unknown[]) => JSON.stringify({ schema: 1, tasks, risks: [] });
const PLAN = plan(T1, IMPL("T2"));

function planner(replies: string[]) {
  return (input: PlannerInput) =>
    runPlanner({
      ...input,
      createSession: async () => {
        const text = replies.shift() ?? replies.at(-1) ?? "";
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
}

/** Writes the right files for each unit; `bad` gives the first attempt of a unit wrong ones. */
function worker(o: { bad?: string; stop?: string } = {}) {
  const seen: Record<string, number> = {};
  const w: Worker = {
    async spawn(input: SpawnInput): Promise<SpawnOutput> {
      const id = input.brief.task.id;
      seen[id] = (seen[id] ?? 0) + 1;
      if (o.stop === id) throw new Stopped("killed");
      const wrong = o.bad === id && seen[id] === 1;
      const files: Record<string, string> =
        id === "T1"
          ? { "test_add.sh": '[ "$(sh add.sh 2 3)" = "5" ]\n' }
          : { "add.sh": wrong ? "echo 0\n" : "echo $(($1 + $2))\n" };
      for (const [p, c] of Object.entries(files)) put(join(input.workdir, p), c);
      return {
        output: { schema: 1, summary: "", claims: [], touched: Object.keys(files) },
        transcript: "",
        usage: { input: 10, output: 20, cache_read: 0, cache_write: 0 },
        exit: "ok",
      };
    },
  };
  return w;
}

async function heph(args: string[], deps: Deps = {}) {
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
  await run([...args, "--json"], io);
  return JSON.parse(out) as { ok: boolean; data?: unknown; error?: { message: string } };
}

async function setup() {
  await heph(["init"]);
  put(
    join(ws, ".heph", "config.yaml"),
    "projects:\n  calc:\n    commands: { test: sh test_add.sh }\n",
  );
}
const create = (id: string, deps: Deps) =>
  heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", id], deps);

async function rtOpen() {
  const loaded = await loadConfig({ workspaceDir: ws, home, nodeId: "test-node" });
  return openRuntime({ loaded, workspaceDir: ws, home });
}

describe("dashboard", () => {
  test("dashboard of a planned run lists plan units with depends_on from consumes/produces", async () => {
    await setup();
    await create("D1", { planner: planner([PLAN]) });
    const rt = await rtOpen();
    const d = rt.dashboard("D1");
    expect(d.plan.units.map((u) => u.id)).toEqual(["T1", "T2"]);
    expect(d.plan.units[0]).toMatchObject({ title: "tests", kind: "test", project: "calc" });
    expect(d.plan.units[1]?.depends_on).toContain("T1");
    expect(d.plan_approved).toBe(false);
    expect(d.pauses).toEqual([]);
    expect(Dashboard.parse(d)).toBeDefined();
    rt.close();
  });

  test("dashboard attaches gate results to the attempt that produced them", async () => {
    await setup();
    const deps: Deps = { planner: planner([PLAN]), worker: worker({ bad: "T2" }) };
    await create("D2", deps);
    await heph(["approve", "plan", "D2"], deps);
    await heph(["run", "D2"], deps);
    const rt = await rtOpen();
    const d = rt.dashboard("D2");
    const first = d.attempts.find((a) => a.unit_id === "T2" && a.attempt === 1);
    const failed = first?.gates.find((g) => g.verdict === "fail");
    expect(failed?.reason).toBeTruthy();
    // Gates of one attempt never leak onto another.
    expect(d.attempts.find((a) => a.unit_id === "T1")?.gates.map((g) => g.verdict)).not.toContain(
      "fail",
    );
    expect(d.units.find((u) => u.unit_id === "T2")).toMatchObject({ in_plan: true });
    expect(Dashboard.parse(d)).toBeDefined();
    rt.close();
  });

  test("dashboard of a run with no plan yet has empty plan.units", async () => {
    await setup();
    const esc = JSON.stringify({ schema: 1, escalate: ["AC1 contradicts decision 1"] });
    await create("D3", { planner: planner([esc]) });
    const rt = await rtOpen();
    const d = rt.dashboard("D3");
    expect(d.plan.units).toEqual([]);
    expect(d.plan_approved).toBe(false);
    expect(Dashboard.parse(d)).toBeDefined();
    rt.close();
  });

  test("dashboard keeps units that are not in the latest plan", async () => {
    await setup();
    const deps: Deps = {
      planner: planner([PLAN, plan(T1, IMPL("T3"))]),
      worker: worker({ stop: "T2" }),
    };
    await create("D4", deps);
    await heph(["approve", "plan", "D4"], deps);
    await heph(["run", "D4"], deps);
    const revised = await heph(["plan", "revise", "D4", "rename the impl"], deps);
    expect(revised.ok).toBe(true);
    const rt = await rtOpen();
    const d = rt.dashboard("D4");
    expect(d.plan.units.map((u) => u.id)).toEqual(["T1", "T3"]);
    expect(d.units.find((u) => u.unit_id === "T2")).toMatchObject({
      in_plan: false,
      status: "dropped",
      attempts: 1,
    });
    expect(d.units.find((u) => u.unit_id === "T1")).toMatchObject({ in_plan: true });
    expect(Dashboard.parse(d)).toBeDefined();
    rt.close();
  });
});
