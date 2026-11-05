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
