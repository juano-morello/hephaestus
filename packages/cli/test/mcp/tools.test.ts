import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DaemonError } from "../../src/daemon.ts";
import { ALLOWED_METHODS, NoDaemonError } from "../../src/mcp/guard.ts";
import { createMcpServer } from "../../src/mcp/server.ts";
import { connectTestClient, fakeDaemon } from "./harness.ts";

describe("heph mcp server", () => {
  test("server identifies itself as heph", async () => {
    const { client: daemon } = fakeDaemon({});
    const client = await connectTestClient({ client: daemon, workspace: () => undefined });
    expect(client.getServerVersion()?.name).toBe("heph");
    await client.close();
  });
});

const task = {
  id: "t1",
  title: "Add widget",
  kind: "feature",
  project: "app",
  lane: "fast",
  complexity: "low",
  scope: ["src/a.ts"],
  covers: ["AC1"],
};
const plan = (approved: boolean) => ({
  run_id: "r1",
  plan_id: "p1",
  approved,
  order: ["t1", "t2"],
  tasks: [task, { ...task, id: "t2", scope: [], covers: [] }],
  risks: ["flaky"],
});
const textOf = (r: unknown) =>
  ((r as { content: { text: string }[] }).content[0] as { text: string }).text;

describe("read-only tools", () => {
  test("lists the three tools with descriptions", async () => {
    const { client: d } = fakeDaemon({});
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const { tools } = await client.listTools();
    for (const n of ["heph_plan_show", "heph_status", "heph_explain"]) {
      const t = tools.find((x) => x.name === n);
      expect(t?.description).toBeTruthy();
    }
    await client.close();
  });

  test("heph_plan_show returns structured plan and approval hint", async () => {
    const { client: d, calls } = fakeDaemon({ planShow: () => plan(false) });
    const client = await connectTestClient({ client: d, workspace: () => "/ws" });
    const r = await client.callTool({ name: "heph_plan_show", arguments: { run: "r1" } });
    expect(r.structuredContent).toEqual(plan(false));
    expect(calls[0]).toEqual({ method: "planShow", args: ["r1"], cwd: "/ws" });
    const text = textOf(r);
    expect(text).toContain("t1");
    expect(text).toContain("t2");
    expect(text).toContain(
      "next: the user approves the plan (heph approve plan r1) — never approve it yourself",
    );
    const ok = await client.callTool({ name: "heph_plan_show", arguments: { run: "r1" } });
    expect(ok.isError).toBeFalsy();
    await client.close();
  });

  test("approved plan has no next line", async () => {
    const { client: d } = fakeDaemon({ planShow: () => plan(true) });
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const r = await client.callTool({ name: "heph_plan_show", arguments: { run: "r1" } });
    expect(textOf(r)).not.toContain("next:");
    await client.close();
  });

  test("heph_status passes [] or [run] and accepts both shapes", async () => {
    const one = {
      run: { run_id: "r1", status: "running" },
      plan_approved: true,
      units: [{ unit_id: "u1", status: "done", attempts: 1 }],
      attempts: [],
      usage: [],
    };
    const list = { runs: [{ run_id: "r1", status: "running", updated_at: "now" }] };
    const { client: d, calls } = fakeDaemon({ status: (a) => (a.length ? one : list) });
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const a = await client.callTool({ name: "heph_status", arguments: {} });
    const b = await client.callTool({ name: "heph_status", arguments: { run: "r1" } });
    // One run also reads the dashboard (for the widget's graph); the list does not.
    expect(calls.filter((c) => c.method === "status").map((c) => c.args)).toEqual([[], ["r1"]]);
    expect(calls.filter((c) => c.method === "dashboard").map((c) => c.args)).toEqual([["r1"]]);
    expect(a.structuredContent).toEqual(list);
    expect(b.structuredContent).toEqual(one);
    expect(textOf(b)).toContain("u1 done (1 attempt)");
    await client.close();
  });

  test("heph_explain passes unit only when given", async () => {
    const x = {
      run_id: "r1",
      events: [{ id: "e1", ts: "2026-01-01T10:20:30Z", type: "t", summary: "did it" }],
    };
    const { client: d, calls } = fakeDaemon({ explain: () => x });
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    await client.callTool({ name: "heph_explain", arguments: { run: "r1" } });
    const r = await client.callTool({ name: "heph_explain", arguments: { run: "r1", unit: "u1" } });
    expect(calls.map((c) => c.args)).toEqual([["r1"], ["r1", "u1"]]);
    expect(textOf(r)).toContain("10:20:30 did it");
    await client.close();
  });

  test("heph_explain shows the repeating gate, evidence, per-attempt changes and a hint category", async () => {
    const x = {
      run_id: "r1",
      events: [{ id: "e1", ts: "2026-01-01T10:20:30Z", type: "t", summary: "did it" }],
      diagnoses: [
        {
          unit_id: "T8",
          gate: "diff_scope",
          reason: "changes outside the task scope",
          repeated: 3,
          evidence: ["out of scope: README.md"],
          attempts: [
            { attempt: 1, outcome: "red", changed: "1 file changed, +1 -0: README.md (+1 -0)" },
            { attempt: 2, outcome: "red" },
          ],
          category: "scope conflict",
          suggestion: "allow them with heph hint --scope <globs>",
        },
      ],
    };
    const { client: d } = fakeDaemon({ explain: () => x });
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const text = textOf(await client.callTool({ name: "heph_explain", arguments: { run: "r1" } }));
    expect(text).toContain("T8 is stuck on diff_scope (failed 3 times in a row)");
    expect(text).toContain("out of scope: README.md");
    expect(text).toContain("a1 red: 1 file changed, +1 -0: README.md (+1 -0)");
    expect(text).toContain("hint category: scope conflict");
    expect(text).toContain("heph hint --scope");
    await client.close();
  });

  test("daemon errors become isError with the message", async () => {
    const { client: d } = fakeDaemon({
      status: () => {
        throw new Error("unknown run r9");
      },
    });
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const r = await client.callTool({ name: "heph_status", arguments: { run: "r9" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("unknown run r9");
    await client.close();
  });

  test("NoDaemonError passes through verbatim", async () => {
    const err = new NoDaemonError();
    const client = await connectTestClient({
      client: {
        call: async () => {
          throw err;
        },
      },
      workspace: () => undefined,
    });
    const r = await client.callTool({ name: "heph_status", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(err.message);
    await client.close();
  });

  test("schema drift is an error", async () => {
    const { client: d } = fakeDaemon({ planShow: () => ({ nope: 1 }) });
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const r = await client.callTool({ name: "heph_plan_show", arguments: { run: "r1" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toStartWith("unexpected daemon answer");
    await client.close();
  });
});

const brief = {
  schema: 1,
  goal: "Add a widget",
  context: "",
  decisions: [],
  constraints: [],
  acceptance: [{ id: "AC1", text: "it works", kind: "behavior" }],
  out_of_scope: [],
  open_questions: [],
  source: "claude-code",
};
const planned = {
  run_id: "r1",
  status: "planned",
  plan_id: "p1",
  planner_attempts: 1,
  tasks: [task],
};

describe("mutating tools", () => {
  test("heph_new sends the brief and cwd, and tells the agent to wait for the user", async () => {
    const { client: d, calls } = fakeDaemon({ newRun: () => planned });
    const client = await connectTestClient({ client: d, workspace: () => "/ws" });
    const r = await client.callTool({
      name: "heph_new",
      arguments: { brief, on: "local" },
    });
    expect(r.isError).toBeFalsy();
    expect(calls[0]).toEqual({ method: "newRun", args: [brief, { on: "local" }], cwd: "/ws" });
    const text = textOf(r);
    expect(text).toContain("t1 feature app (fast): Add widget");
    expect(text).toContain("next: show the plan to the user");
    expect(text).toContain("heph approve plan r1");
    expect(text).toContain("themselves");
    await client.close();
  });

  test("heph_new without on sends empty options", async () => {
    const { client: d, calls } = fakeDaemon({ newRun: () => planned });
    const client = await connectTestClient({ client: d, workspace: () => "/ws" });
    await client.callTool({ name: "heph_new", arguments: { brief } });
    expect(calls[0]?.args).toEqual([brief, {}]);
    await client.close();
  });

  test("heph_new renders an escalated plan's reason", async () => {
    const { client: d } = fakeDaemon({
      newRun: () => ({
        run_id: "r2",
        status: "escalated",
        planner_attempts: 2,
        escalate: ["scope unclear"],
        reason: "planner gave up",
      }),
    });
    const client = await connectTestClient({ client: d, workspace: () => "/ws" });
    const r = await client.callTool({ name: "heph_new", arguments: { brief } });
    expect(textOf(r)).toContain("r2: escalated after 2 planner attempt(s)");
    expect(textOf(r)).toContain("- scope unclear");
    expect(textOf(r)).toContain("planner gave up");
    expect(textOf(r)).not.toContain("next:");
    await client.close();
  });

  test("heph_new rejects a brief missing goal without calling the daemon", async () => {
    const { client: d, calls } = fakeDaemon({ newRun: () => planned });
    const client = await connectTestClient({ client: d, workspace: () => "/ws" });
    const { goal: _goal, ...noGoal } = brief;
    const r = await client.callTool({ name: "heph_new", arguments: { brief: noGoal } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("goal");
    expect(calls).toHaveLength(0);
    await client.close();
  });

  test("heph_new rejects a string brief", async () => {
    const { client: d, calls } = fakeDaemon({ newRun: () => planned });
    const client = await connectTestClient({ client: d, workspace: () => "/ws" });
    const r = await client.callTool({ name: "heph_new", arguments: { brief: "do it" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("brief must be an object");
    expect(calls).toHaveLength(0);
    await client.close();
  });

  test("heph_new with no workspace anywhere names the problem and the argument", async () => {
    const { client: d, calls } = fakeDaemon({ newRun: () => planned });
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const r = await client.callTool({ name: "heph_new", arguments: { brief } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("workspace");
    expect(textOf(r)).toContain("directory");
    expect(calls).toHaveLength(0);
    await client.close();
  });

  test("heph_new resolves a relative workspace against the server's cwd", async () => {
    const { client: d, calls } = fakeDaemon({ newRun: () => planned });
    const client = await connectTestClient({
      client: d,
      workspace: () => undefined,
      cwd: "/srv/proj",
    });
    await client.callTool({ name: "heph_new", arguments: { brief, workspace: "." } });
    await client.callTool({ name: "heph_new", arguments: { brief, workspace: "../other" } });
    expect(calls.map((c) => c.cwd)).toEqual(["/srv/proj", "/srv/other"]);
    await client.close();
  });

  test("heph_new's no-workspace error names the directory searched", async () => {
    const { client: d } = fakeDaemon({ newRun: () => planned });
    const client = await connectTestClient({
      client: d,
      workspace: () => undefined,
      cwd: "/srv/proj",
    });
    const r = await client.callTool({ name: "heph_new", arguments: { brief } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("/srv/proj");
    expect(textOf(r)).toContain("workspace argument");
    await client.close();
  });

  test("heph_new workspace argument overrides the server's workspace", async () => {
    const { client: d, calls } = fakeDaemon({ newRun: () => planned });
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const r = await client.callTool({
      name: "heph_new",
      arguments: { brief, workspace: "/other" },
    });
    expect(r.isError).toBeFalsy();
    expect(calls[0]?.cwd).toBe("/other");
    await client.close();
  });

  test("heph_plan_revise maps to revise and renders the plan", async () => {
    const { client: d, calls } = fakeDaemon({ revise: () => planned });
    const client = await connectTestClient({ client: d, workspace: () => "/ws" });
    const r = await client.callTool({
      name: "heph_plan_revise",
      arguments: { run: "r1", instructions: "split t1" },
    });
    expect(calls[0]).toEqual({ method: "revise", args: ["r1", "split t1"], cwd: "/ws" });
    expect(textOf(r)).toContain("run r1: planned");
    await client.close();
  });

  test("heph_hint omits scope and budget when absent, passes them when given", async () => {
    const hinted = { run_id: "r1", unit: "u1", recorded: ["a hint"] };
    const { client: d, calls } = fakeDaemon({ hint: () => hinted });
    const client = await connectTestClient({ client: d, workspace: () => "/ws" });
    await client.callTool({
      name: "heph_hint",
      arguments: { run: "r1", unit: "u1", text: "try x" },
    });
    const r = await client.callTool({
      name: "heph_hint",
      arguments: { run: "r1", unit: "u1", text: "try x", scope: ["src/b.ts"], budget: 5000 },
    });
    expect(calls[0]?.args).toEqual(["r1", "u1", "try x", {}]);
    expect(calls[1]?.args).toEqual(["r1", "u1", "try x", { scope: ["src/b.ts"], budget: 5000 }]);
    expect(textOf(r)).toContain("recorded a hint for u1 in r1");
    await client.close();
  });

  test("heph_cancel maps to cancel", async () => {
    const { client: d, calls } = fakeDaemon({ cancel: () => ({ run_id: "r1", status: "failed" }) });
    const client = await connectTestClient({ client: d, workspace: () => "/ws" });
    const r = await client.callTool({ name: "heph_cancel", arguments: { run: "r1" } });
    expect(calls[0]).toEqual({ method: "cancel", args: ["r1"], cwd: "/ws" });
    expect(textOf(r)).toBe("cancelled r1\n");
    await client.close();
  });

  test("heph_new tells the model the real Brief shape", async () => {
    const { client: d } = fakeDaemon({});
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const { tools } = await client.listTools();
    const props = (tools.find((t) => t.name === "heph_new")?.inputSchema.properties ??
      {}) as Record<string, { description?: string }>;
    const desc = props.brief?.description ?? "";
    for (const w of ["decisions", "out_of_scope", "open_questions", "claude-code", "strict"])
      expect(desc).toContain(w);
    await client.close();
  });

  test("a result with no tasks has no blank line", async () => {
    const { client: d } = fakeDaemon({
      newRun: () => ({
        run_id: "r3",
        status: "failed",
        planner_attempts: 1,
        tasks: [],
        reason: "x",
      }),
    });
    const client = await connectTestClient({ client: d, workspace: () => "/ws" });
    const r = await client.callTool({ name: "heph_new", arguments: { brief } });
    expect(textOf(r)).toBe("run r3: failed after 1 planner attempt(s)\n  x\n");
    await client.close();
  });
});

const statusOf = (status: string, plan_approved = true) => ({
  run: { run_id: "r1", status },
  plan_approved,
  units: [],
  attempts: [],
  usage: [],
});
const ev = (id: string, type: string, summary: string, extra: Record<string, unknown> = {}) => ({
  id,
  ts: "2026-11-05T10:00:00Z",
  type,
  summary,
  ...extra,
});
/** A clock that only moves when the code under test sleeps. */
const fakeClock = () => {
  let t = 1_000_000;
  return {
    elapsed: () => t - 1_000_000,
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
};

describe("heph_run", () => {
  test("an unapproved plan is not run: the user approves it themselves", async () => {
    const { client: d, calls } = fakeDaemon({ status: () => statusOf("planned", false) });
    const client = await connectTestClient({ client: d, workspace: () => "/ws" });
    const r = await client.callTool({ name: "heph_run", arguments: { run: "r1" } });
    expect(r.isError).toBeFalsy();
    expect(calls.map((c) => c.method)).toEqual(["status"]);
    expect(calls[0]).toEqual({ method: "status", args: ["r1"], cwd: "/ws" });
    expect(r.structuredContent).toMatchObject({
      run_id: "r1",
      state: "awaiting_plan_approval",
      status: "planned",
      lines: [],
    });
    expect(textOf(r)).toContain("ask the user to run `heph approve plan r1` themselves");
    await client.close();
  });

  test("an approved plan is run once and its first lines come back", async () => {
    const clock = fakeClock();
    const events = [ev("e1", "run.plan_ready", "plan ready")];
    const { client: d, calls } = fakeDaemon({
      status: () => statusOf("running"),
      run: () => {
        events.push(
          ev("e2", "unit.attempt.started", "attempt started", { unit_id: "u1", attempt: 1 }),
        );
        return { run_id: "r1", started: true, after: "e1" };
      },
      explain: () => ({ run_id: "r1", events }),
    });
    const client = await connectTestClient({ client: d, workspace: () => "/ws", ...clock });
    const r = await client.callTool({ name: "heph_run", arguments: { run: "r1" } });
    expect(r.isError).toBeFalsy();
    const runs = calls.filter((c) => c.method === "run");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ method: "run", args: ["r1", {}], cwd: "/ws" });
    expect(r.structuredContent).toEqual({
      run_id: "r1",
      state: "started",
      status: "running",
      lines: ["u1/a1 attempt started"],
      cursor: "e2",
      outcome: "running",
    });
    expect(clock.elapsed()).toBe(0);
    expect(textOf(r)).toContain("u1/a1 attempt started");
    expect(textOf(r)).toContain("heph_watch");
    await client.close();
  });

  test("a run that is already going is already_running, not an error", async () => {
    const clock = fakeClock();
    const { client: d } = fakeDaemon({
      status: () => statusOf("running"),
      run: () => ({ run_id: "r1", started: false, running: true, after: "e1" }),
      explain: () => ({ run_id: "r1", events: [ev("e1", "run.plan_ready", "plan ready")] }),
    });
    const client = await connectTestClient({ client: d, workspace: () => "/ws", ...clock });
    const r = await client.callTool({ name: "heph_run", arguments: { run: "r1" } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ state: "already_running", cursor: "e1" });
    expect(textOf(r)).toContain("already running");
    await client.close();
  });

  test("a daemon refusal is an error with its message", async () => {
    const { client: d } = fakeDaemon({
      status: () => statusOf("paused"),
      run: () => {
        throw new Error("the planner escalated r1; see heph explain r1");
      },
    });
    const client = await connectTestClient({ client: d, workspace: () => "/ws" });
    const r = await client.callTool({ name: "heph_run", arguments: { run: "r1" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("the planner escalated r1; see heph explain r1");
    await client.close();
  });
});

describe("heph_run on a run that cannot run", () => {
  for (const [status, events, outcome, next] of [
    [
      "staged",
      [ev("e1", "merge.staged", "staged for merge")],
      "staged",
      "tell the user to review, then run `heph approve merge r1` themselves",
    ],
    [
      "finished",
      [ev("e1", "run.finished", "finished")],
      "finished",
      "tell the user the run finished",
    ],
    [
      "failed",
      [ev("e1", "run.failed", "failed: gate")],
      "failed",
      "explain to the user and ask; do not retry",
    ],
    [
      "escalated",
      [ev("e1", "run.plan_escalated", "planner escalated")],
      "planner_escalated",
      "explain to the user and ask; do not retry",
    ],
  ] as const) {
    test(`${status}: run is never called, state not_runnable`, async () => {
      const { client: d, calls } = fakeDaemon({
        status: () => statusOf(status),
        explain: () => ({ run_id: "r1", events: [...events] }),
        run: () => ({ run_id: "r1", started: true }),
      });
      const client = await connectTestClient({ client: d, workspace: () => "/ws", ...fakeClock() });
      const r = await client.callTool({ name: "heph_run", arguments: { run: "r1" } });
      expect(r.isError).toBeFalsy();
      expect(calls.map((c) => c.method)).not.toContain("run");
      expect(r.structuredContent).toMatchObject({
        run_id: "r1",
        state: "not_runnable",
        status,
        cursor: "e1",
        outcome,
      });
      expect(textOf(r)).toContain(`not started: it is ${status}`);
      expect(textOf(r)).toContain(`next: ${next}`);
      await client.close();
    });
  }

  test("created: no plan yet, run is never called, no approval hint", async () => {
    const { client: d, calls } = fakeDaemon({
      status: () => statusOf("created", false),
      explain: () => ({ run_id: "r1", events: [] }),
      run: () => ({ run_id: "r1", started: true }),
    });
    const client = await connectTestClient({ client: d, workspace: () => "/ws", ...fakeClock() });
    const r = await client.callTool({ name: "heph_run", arguments: { run: "r1" } });
    expect(r.isError).toBeFalsy();
    expect(calls.map((c) => c.method)).not.toContain("run");
    expect(r.structuredContent).toMatchObject({ state: "not_runnable", status: "created" });
    expect(textOf(r)).toContain(
      "next: check it with heph_status, or plan it with heph_plan_revise",
    );
    expect(textOf(r)).not.toMatch(/approve/i);
    await client.close();
  });

  test("running without an approved plan still resumes through run", async () => {
    const { client: d, calls } = fakeDaemon({
      status: () => statusOf("running", false),
      explain: () => ({ run_id: "r1", events: [ev("e1", "run.resumed", "resumed")] }),
      run: () => ({ run_id: "r1", started: true, after: "e1" }),
    });
    const client = await connectTestClient({ client: d, workspace: () => "/ws", ...fakeClock() });
    const r = await client.callTool({ name: "heph_run", arguments: { run: "r1" } });
    expect(calls.filter((c) => c.method === "run")).toHaveLength(1);
    expect(r.structuredContent).toMatchObject({ state: "started" });
    await client.close();
  });

  for (const status of ["planned", "paused", "built"] as const)
    test(`${status} with an unapproved plan is awaiting_plan_approval, run never called`, async () => {
      const { client: d, calls } = fakeDaemon({
        status: () => statusOf(status, false),
        explain: () => ({ run_id: "r1", events: [ev("e1", "run.plan_ready", "plan ready")] }),
        run: () => ({ run_id: "r1", started: true, after: "e1" }),
      });
      const client = await connectTestClient({ client: d, workspace: () => "/ws", ...fakeClock() });
      const r = await client.callTool({ name: "heph_run", arguments: { run: "r1" } });
      expect(r.isError).toBeFalsy();
      expect(calls.map((c) => c.method)).toEqual(["status"]);
      expect(r.structuredContent).toEqual({
        run_id: "r1",
        state: "awaiting_plan_approval",
        status,
        lines: [],
      });
      expect(textOf(r)).toContain("ask the user to run `heph approve plan r1` themselves");
      await client.close();
    });

  test("heph_run is bounded as a whole: a hung daemon is an error within its budget", async () => {
    for (const hang of ["status", "run", "explain"] as const) {
      const { client: d } = fakeDaemon({
        status: () => (hang === "status" ? new Promise(() => {}) : statusOf("running")),
        run: () =>
          hang === "run" ? new Promise(() => {}) : { run_id: "r1", started: true, after: "e1" },
        explain: () => new Promise(() => {}),
      });
      const client = await connectTestClient({
        client: d,
        workspace: () => "/ws",
        runBudgetMs: 60,
      });
      const t0 = Date.now();
      const r = await client.callTool({ name: "heph_run", arguments: { run: "r1" } });
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("not answering in time");
      await client.close();
    }
  });

  test("a run that stops right after starting says so", async () => {
    const events = [ev("e1", "run.plan_ready", "plan ready")];
    let ran = false;
    const { client: d } = fakeDaemon({
      status: () => statusOf(ran ? "failed" : "paused"),
      run: () => {
        ran = true;
        events.push(ev("e2", "run.failed", "failed: no budget"));
        return { run_id: "r1", started: true, after: "e1" };
      },
      explain: () => ({ run_id: "r1", events }),
    });
    const client = await connectTestClient({ client: d, workspace: () => "/ws", ...fakeClock() });
    const r = await client.callTool({ name: "heph_run", arguments: { run: "r1" } });
    expect(r.structuredContent).toMatchObject({ state: "started", outcome: "failed" });
    expect(textOf(r)).toContain("it has already stopped: failed");
    expect(textOf(r)).toContain("next: explain to the user and ask; do not retry");
    await client.close();
  });
});

describe("heph_watch", () => {
  const quiet = () =>
    fakeDaemon({
      status: () => statusOf("running"),
      explain: () => ({ run_id: "r1", events: [ev("e1", "run.plan_ready", "plan ready")] }),
    });

  test("passes since: only newer milestones come back, with the next cursor", async () => {
    const clock = fakeClock();
    const { client: d } = fakeDaemon({
      status: () => statusOf("running"),
      explain: () => ({
        run_id: "r1",
        events: [
          ev("e1", "run.plan_ready", "plan ready"),
          ev("e2", "unit.attempt.started", "attempt started", { unit_id: "u1", attempt: 1 }),
        ],
      }),
    });
    const client = await connectTestClient({ client: d, workspace: () => "/ws", ...clock });
    const r = await client.callTool({ name: "heph_watch", arguments: { run: "r1", since: "e1" } });
    expect(r.structuredContent).toMatchObject({
      run_id: "r1",
      status: "running",
      lines: ["u1/a1 attempt started"],
      cursor: "e2",
      outcome: "running",
    });
    expect(textOf(r)).toContain("since");
    expect(textOf(r)).toContain("e2");
    await client.close();
  });

  for (const [wait_s, ms] of [
    [999, 25_000],
    [-3, 0],
    [undefined, 20_000],
  ] as const) {
    test(`wait_s ${wait_s} waits ${ms} ms`, async () => {
      const clock = fakeClock();
      const { client: d } = quiet();
      const client = await connectTestClient({ client: d, workspace: () => "/ws", ...clock });
      const r = await client.callTool({
        name: "heph_watch",
        arguments: { run: "r1", since: "e1", ...(wait_s === undefined ? {} : { wait_s }) },
      });
      expect(r.isError).toBeFalsy();
      expect(clock.elapsed()).toBe(ms);
      expect((r.structuredContent as { lines: string[] }).lines).toEqual(["r1: still running"]);
      await client.close();
    });
  }

  const outcomeCase = (status: string, events: ReturnType<typeof ev>[], plan_approved = true) =>
    fakeDaemon({
      status: () => statusOf(status, plan_approved),
      explain: () => ({ run_id: "r1", events }),
    });
  for (const [name, status, events, next] of [
    [
      "waiting_for_you",
      "paused",
      [ev("e1", "run.paused", "paused: waiting for you")],
      "explain to the user and ask; do not retry",
    ],
    ["planner_escalated", "escalated", [], "explain to the user and ask; do not retry"],
    [
      "staged",
      "staged",
      [ev("e1", "merge.staged", "staged")],
      "tell the user to review, then run `heph approve merge r1` themselves",
    ],
  ] as const) {
    test(`outcome ${name} says what to do next`, async () => {
      const { client: d } = outcomeCase(status, [...events]);
      const client = await connectTestClient({ client: d, workspace: () => "/ws", ...fakeClock() });
      const r = await client.callTool({ name: "heph_watch", arguments: { run: "r1" } });
      expect((r.structuredContent as { outcome: string }).outcome).toBe(name);
      expect(textOf(r)).toContain(`next: ${next}`);
      await client.close();
    });
  }

  for (const [name, parent, lines, next] of [
    [
      "waiting_for_parent",
      "staged",
      ["r1: staged", "staged", "waiting for P"],
      "wait for P: tell the user to merge it first (`heph approve merge P`, themselves); then r1 is restacked and the user approves it",
    ],
    [
      "blocked_by_parent",
      "failed",
      ["r1: staged", "staged", "stacked on P (failed): rebuild r1"],
      "explain to the user that its parent cannot land, so r1 has to be rebuilt; ask; do not retry",
    ],
  ] as const) {
    test(`a stacked run with a ${parent} parent is ${name}, in valid structured output`, async () => {
      const { client: d } = fakeDaemon({
        status: () => ({ ...statusOf("staged"), stack_on: { run_id: "P", status: parent } }),
        explain: () => ({ run_id: "r1", events: [ev("e1", "merge.staged", "staged")] }),
      });
      const client = await connectTestClient({ client: d, workspace: () => "/ws", ...fakeClock() });
      for (const tool of ["heph_watch", "heph_run"]) {
        const r = await client.callTool({ name: tool, arguments: { run: "r1" } });
        expect(r.isError).toBeFalsy();
        expect(r.structuredContent).toMatchObject({ outcome: name, lines: [...lines] });
        expect(textOf(r)).toContain(`next: ${next}`);
      }
      await client.close();
    });
  }

  test("a stalled pause is waiting_for_you", async () => {
    const { client: d } = outcomeCase("paused", [
      ev("e1", "unit.stalled", "stalled: tests failed the same way on a1 and a2", {
        unit_id: "u1",
      }),
      ev("e2", "run.paused", "run paused: waiting for you"),
    ]);
    const client = await connectTestClient({ client: d, workspace: () => "/ws", ...fakeClock() });
    const r = await client.callTool({ name: "heph_watch", arguments: { run: "r1", since: "e0" } });
    expect(r.structuredContent).toMatchObject({
      run_id: "r1",
      status: "paused",
      lines: ["u1 stalled: tests failed the same way on a1 and a2", "run paused: waiting for you"],
      cursor: "e2",
      outcome: "waiting_for_you",
    });
    expect(textOf(r)).toContain("next: explain to the user and ask; do not retry");
    // Every return carries the run's current view, for the run widget.
    expect(r.structuredContent).toMatchObject({
      run: { run_id: "r1", status: "paused" },
      units: [],
      attempts: [],
    });
    await client.close();
  });

  test("the heph_watch description lists every outcome", async () => {
    const { client: d } = fakeDaemon({});
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const { tools } = await client.listTools();
    const desc = tools.find((t) => t.name === "heph_watch")?.description ?? "";
    for (const o of [
      "running",
      "awaiting_plan_approval",
      "waiting_for_you",
      "planner_escalated",
      "waiting_for_parent",
      "blocked_by_parent",
      "staged",
      "finished",
      "failed",
    ])
      expect(desc).toContain(o);
    await client.close();
  });

  test("a daemon that fails 5 times then recovers gives a normal result", async () => {
    let fails = 5;
    const clock = fakeClock();
    const { client: d } = fakeDaemon({
      status: () => {
        if (fails-- > 0) throw new NoDaemonError();
        return statusOf("running");
      },
      explain: () => ({ run_id: "r1", events: [ev("e1", "run.plan_ready", "plan ready")] }),
    });
    const client = await connectTestClient({ client: d, workspace: () => "/ws", ...clock });
    const r = await client.callTool({ name: "heph_watch", arguments: { run: "r1" } });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { lines: string[] }).lines).toEqual([
      "r1: running",
      "plan ready",
    ]);
    expect(clock.elapsed()).toBe(10_000);
    await client.close();
  });

  test("a daemon that stays down is an error after the retry window", async () => {
    const clock = fakeClock();
    const { client: d, calls } = fakeDaemon({
      status: () => {
        throw new NoDaemonError();
      },
    });
    const client = await connectTestClient({ client: d, workspace: () => "/ws", ...clock });
    const r = await client.callTool({ name: "heph_watch", arguments: { run: "r9" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("heph daemon is not running");
    expect(clock.elapsed()).toBe(16_000);
    expect(calls).toHaveLength(9);
    await client.close();
  });

  test("an unknown run id is an error at once, with no retries", async () => {
    const clock = fakeClock();
    const { client: d, calls } = fakeDaemon({
      status: () => {
        throw new DaemonError("unknown run r9");
      },
    });
    const client = await connectTestClient({ client: d, workspace: () => "/ws", ...clock });
    const r = await client.callTool({ name: "heph_watch", arguments: { run: "r9" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("unknown run r9");
    expect(clock.elapsed()).toBe(0);
    expect(calls).toHaveLength(1);
    await client.close();
  });

  test("a cancelled heph_watch stops polling", async () => {
    let t = 1_000_000;
    const { client: d, calls } = fakeDaemon({
      status: () => statusOf("running"),
      explain: () => ({ run_id: "r1", events: [ev("e1", "run.plan_ready", "plan ready")] }),
    });
    // Virtual time for the deadline, a little real time per wait so the cancel lands mid-poll.
    const client = await connectTestClient({
      client: d,
      workspace: () => "/ws",
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        await Bun.sleep(10);
      },
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 25);
    await expect(
      client.callTool({ name: "heph_watch", arguments: { run: "r1", since: "e1" } }, undefined, {
        signal: ac.signal,
      }),
    ).rejects.toThrow();
    await Bun.sleep(150);
    const polls = calls.filter((c) => c.method === "status").length;
    // Uncancelled, a 20 s watch at 2 s polls 11 times.
    expect(polls).toBeLessThan(6);
    await Bun.sleep(100);
    expect(calls.filter((c) => c.method === "status").length).toBe(polls);
    await client.close();
  });

  test("a daemon that never answers is cut at the overall deadline, with call again", async () => {
    const { client: d } = fakeDaemon({ status: () => new Promise(() => {}) });
    const client = await connectTestClient({ client: d, workspace: () => "/ws", graceMs: 50 });
    const t0 = Date.now();
    const r = await client.callTool({ name: "heph_watch", arguments: { run: "r1", wait_s: 0 } });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("not answering in time");
    expect(textOf(r)).toContain("call heph_watch again");
    await client.close();
  });

  test("a failing progress send does not fail the watch", async () => {
    const events = [
      ev("e1", "run.plan_ready", "plan ready"),
      ev("e2", "unit.attempt.started", "attempt started", { unit_id: "u1", attempt: 1 }),
    ];
    const { client: d } = fakeDaemon({
      status: () => statusOf("running"),
      explain: () => ({ run_id: "r1", events }),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const send = serverSide.send.bind(serverSide);
    let dropped = 0;
    serverSide.send = async (m, o) => {
      if ("method" in m && m.method === "notifications/progress") {
        dropped++;
        throw new Error("Not connected");
      }
      return send(m, o);
    };
    await createMcpServer({ client: d, workspace: () => "/ws", ...fakeClock() }).connect(
      serverSide,
    );
    const client = new Client({ name: "heph-test", version: "0" });
    await client.connect(clientSide);
    const r = await client.callTool({ name: "heph_watch", arguments: { run: "r1" } }, undefined, {
      onprogress: () => {},
    });
    expect(dropped).toBe(3);
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { lines: string[] }).lines).toEqual([
      "r1: running",
      "plan ready",
      "u1/a1 attempt started",
    ]);
    await client.close();
  });

  test("description says what to do when no cursor comes back", async () => {
    const { client: d } = fakeDaemon({});
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const { tools } = await client.listTools();
    const desc = tools.find((t) => t.name === "heph_watch")?.description ?? "";
    expect(desc).toContain("no cursor");
    expect(desc).toContain("tight");
    await client.close();
  });

  test("progress: one notification per line with a token, none without", async () => {
    const events = [
      ev("e1", "run.plan_ready", "plan ready"),
      ev("e2", "unit.attempt.started", "attempt started", { unit_id: "u1", attempt: 1 }),
    ];
    const mk = () =>
      fakeDaemon({
        status: () => statusOf("running"),
        explain: () => ({ run_id: "r1", events }),
      });
    const withToken = await connectTestClient({
      client: mk().client,
      workspace: () => "/ws",
      ...fakeClock(),
    });
    const seen: { progress: number; message?: string }[] = [];
    const a = await withToken.callTool(
      { name: "heph_watch", arguments: { run: "r1" } },
      undefined,
      {
        onprogress: (p) => seen.push({ progress: p.progress, message: p.message }),
      },
    );
    const lines = (a.structuredContent as { lines: string[] }).lines;
    expect(lines.length).toBeGreaterThan(1);
    expect(seen).toEqual(lines.map((message, i) => ({ progress: i + 1, message })));

    const without = await connectTestClient({
      client: mk().client,
      workspace: () => "/ws",
      ...fakeClock(),
    });
    const notes: unknown[] = [];
    without.fallbackNotificationHandler = async (n) => {
      notes.push(n);
    };
    const b = await without.callTool({ name: "heph_watch", arguments: { run: "r1" } });
    expect(notes).toEqual([]);
    expect(b).toEqual(a);
    await withToken.close();
    await without.close();
  });
});

describe("empty strings are rejected", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["heph_plan_show", { run: "" }],
    ["heph_status", { run: "" }],
    ["heph_explain", { run: "" }],
    ["heph_explain", { run: "r1", unit: "" }],
    ["heph_plan_revise", { run: "", instructions: "x" }],
    ["heph_plan_revise", { run: "r1", instructions: "" }],
    ["heph_hint", { run: "", unit: "T1", text: "x" }],
    ["heph_hint", { run: "r1", unit: "", text: "x" }],
    ["heph_hint", { run: "r1", unit: "T1", text: "" }],
    ["heph_hint", { run: "r1", unit: "T1", text: "x", scope: [""] }],
    ["heph_cancel", { run: "" }],
    ["heph_run", { run: "" }],
    ["heph_watch", { run: "" }],
    ["heph_watch", { run: "r1", since: "" }],
    ["heph_new", { brief, workspace: "" }],
    ["heph_new", { brief, on: "" }],
  ];
  for (const [name, args] of cases)
    test(`${name} with ${Object.keys(args)
      .filter(
        (k) => args[k] === "" || (Array.isArray(args[k]) && (args[k] as unknown[]).includes("")),
      )
      .join(", ")} empty is a validation error, no daemon call`, async () => {
      const { client: d, calls } = fakeDaemon({});
      const client = await connectTestClient({ client: d, workspace: () => "/ws", ...fakeClock() });
      const r = await client
        .callTool({ name, arguments: args })
        .catch((e: unknown) => ({ isError: true, content: [{ type: "text", text: String(e) }] }));
      expect(r.isError).toBe(true);
      expect(calls).toEqual([]);
      await client.close();
    });

  test("heph_status with run omitted still lists every run", async () => {
    const { client: d, calls } = fakeDaemon({ status: () => ({ runs: [] }) });
    const client = await connectTestClient({ client: d, workspace: () => "/ws" });
    await client.callTool({ name: "heph_status", arguments: {} });
    expect(calls).toEqual([{ method: "status", args: [], cwd: "/ws" }]);
    await client.close();
  });
});

describe("tool-set safety", () => {
  const NINE = [
    "heph_cancel",
    "heph_explain",
    "heph_hint",
    "heph_new",
    "heph_plan_revise",
    "heph_plan_show",
    "heph_run",
    "heph_status",
    "heph_watch",
  ];

  test("exactly the nine tools, none of them approves", async () => {
    const { client: d } = fakeDaemon({});
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(NINE);
    for (const n of names) expect(n).not.toMatch(/approve/i);
    await client.close();
  });

  test("calling every tool reaches only allowed daemon methods", async () => {
    const { client: d, calls } = fakeDaemon({
      newRun: () => planned,
      planShow: () => plan(true),
      revise: () => planned,
      run: () => ({ run_id: "r1", started: true, after: "e1" }),
      status: () => statusOf("running"),
      explain: () => ({ run_id: "r1", events: [ev("e1", "run.plan_ready", "plan ready")] }),
      hint: () => ({ run_id: "r1", unit: "u1", recorded: ["a hint"] }),
      cancel: () => ({ run_id: "r1", status: "failed" }),
    });
    const client = await connectTestClient({ client: d, workspace: () => "/ws", ...fakeClock() });
    const args: Record<string, Record<string, unknown>> = {
      heph_new: { brief },
      heph_plan_show: { run: "r1" },
      heph_plan_revise: { run: "r1", instructions: "x" },
      heph_run: { run: "r1" },
      heph_watch: { run: "r1", wait_s: 0 },
      heph_status: { run: "r1" },
      heph_explain: { run: "r1" },
      heph_hint: { run: "r1", unit: "u1", text: "x" },
      heph_cancel: { run: "r1" },
    };
    for (const name of NINE) {
      const r = await client.callTool({ name, arguments: args[name] });
      expect({ name, isError: r.isError }).toEqual({ name, isError: undefined });
    }
    expect(calls.length).toBeGreaterThanOrEqual(NINE.length);
    for (const c of calls) expect(ALLOWED_METHODS as readonly string[]).toContain(c.method);
    await client.close();
  });
});
