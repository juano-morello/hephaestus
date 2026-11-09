import { describe, expect, test } from "bun:test";
import { RUN_HTML } from "../../../src/mcp/app/generated.ts";
import { connectTestClient, fakeDaemon } from "../harness.ts";

const one = {
  run: { run_id: "r1", status: "running" },
  plan_approved: true,
  units: [{ unit_id: "u1", status: "done", attempts: 1 }],
  attempts: [{ unit_id: "u1", attempt: 1, status: "passed" }],
  usage: [{ provider: "p", model: "m", input: 3 }],
};
const list = { runs: [{ run_id: "r1", status: "running", updated_at: "now" }] };
const dashboard = {
  schema: 1,
  run: one.run,
  plan_approved: true,
  plan: {
    units: [{ id: "u1", title: "First", kind: "feature", project: "app", depends_on: [] }],
  },
  units: [{ unit_id: "u1", status: "done", attempts: 1, in_plan: true }],
  attempts: [
    {
      unit_id: "u1",
      attempt: 1,
      status: "passed",
      model: "m",
      gates: [{ gate: "test", verdict: "pass", reason: "ok", evidence: ["e"] }],
    },
  ],
  pauses: [],
  usage: [],
};
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";

describe("run widget wiring", () => {
  test("heph_status points at the run widget (current and flat meta keys)", async () => {
    const { client: d } = fakeDaemon({});
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const { tools } = await client.listTools();
    expect(tools.find((x) => x.name === "heph_status")?._meta).toEqual({
      ui: { resourceUri: "ui://heph/run" },
      "ui/resourceUri": "ui://heph/run",
    });
    expect(
      tools
        .filter((x) => x._meta?.ui)
        .map((x) => x.name)
        .sort(),
    ).toEqual(["heph_plan_show", "heph_status", "heph_watch"]);
    await client.close();
  });

  test("resources/read ui://heph/run serves the page as an MCP App", async () => {
    const { client: d } = fakeDaemon({});
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("ui://heph/run");
    const r = await client.readResource({ uri: "ui://heph/run" });
    expect(r.contents).toHaveLength(1);
    expect(r.contents[0]).toMatchObject({
      uri: "ui://heph/run",
      mimeType: "text/html;profile=mcp-app",
    });
    expect((r.contents[0] as { text: string }).text).toBe(RUN_HTML);
    await client.close();
  });

  test("a single run gets an additive graph; text and the other fields are unchanged", async () => {
    const { client: d, calls } = fakeDaemon({
      status: () => one,
      dashboard: () => dashboard,
    });
    const client = await connectTestClient({ client: d, workspace: () => "/ws" });
    const r = await client.callTool({ name: "heph_status", arguments: { run: "r1" } });
    const sc = r.structuredContent as Record<string, unknown>;
    const { graph, ...rest } = sc;
    expect(rest).toEqual(one);
    expect(graph).toEqual({
      units: dashboard.plan.units,
      attempts: dashboard.attempts,
      pauses: [],
    });
    expect(textOf(r)).toBe("run r1: running\n  u1 done (1 attempt)\n  m: in 3 out 0 cache 0\n");
    expect(calls.find((c) => c.method === "dashboard")).toEqual({
      method: "dashboard",
      args: ["r1"],
      cwd: "/ws",
    });
    await client.close();
  });

  test("the list has no graph and makes no dashboard call", async () => {
    const { client: d, calls } = fakeDaemon({ status: () => list, dashboard: () => dashboard });
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const r = await client.callTool({ name: "heph_status", arguments: {} });
    expect(r.structuredContent).toEqual(list);
    expect(calls.map((c) => c.method)).toEqual(["status"]);
    await client.close();
  });

  test("a failing or malformed dashboard read still gives the plain status", async () => {
    for (const dash of [
      () => {
        throw new Error("daemon says no");
      },
      () => ({ nonsense: true }),
    ]) {
      const { client: d } = fakeDaemon({ status: () => one, dashboard: dash });
      const client = await connectTestClient({ client: d, workspace: () => undefined });
      const r = await client.callTool({ name: "heph_status", arguments: { run: "r1" } });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toEqual(one);
      await client.close();
    }
  });

  test("a failing status is still an error and a stale status keeps its note", async () => {
    const { client: d } = fakeDaemon({
      status: () => {
        throw new Error("unknown run r9");
      },
      dashboard: () => dashboard,
    });
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const r = await client.callTool({ name: "heph_status", arguments: { run: "r9" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("unknown run r9");
    await client.close();
  });
});
