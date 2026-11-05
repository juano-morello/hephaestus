import { describe, expect, test } from "bun:test";
import { NoDaemonError } from "../../src/mcp/guard.ts";
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
    expect(calls.map((c) => c.args)).toEqual([[], ["r1"]]);
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
});
