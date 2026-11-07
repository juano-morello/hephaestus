import { describe, expect, test } from "bun:test";
import { PLAN_HTML } from "../../../src/mcp/app/generated.ts";
import { connectTestClient, fakeDaemon } from "../harness.ts";

const plan = {
  run_id: "r1",
  plan_id: "p1",
  approved: false,
  order: ["t1"],
  tasks: [
    {
      id: "t1",
      title: "A",
      kind: "feature",
      project: "app",
      lane: "fast",
      complexity: "low",
      scope: ["a.ts"],
      covers: ["AC1"],
    },
  ],
  risks: [],
};

describe("plan widget wiring", () => {
  test("heph_plan_show points at the widget (current and flat meta keys)", async () => {
    const { client: d } = fakeDaemon({});
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "heph_plan_show");
    expect(t?._meta).toEqual({
      ui: { resourceUri: "ui://heph/plan" },
      "ui/resourceUri": "ui://heph/plan",
    });
    expect(tools.filter((x) => x._meta?.ui).map((x) => x.name)).toEqual(["heph_plan_show"]);
    await client.close();
  });

  test("resources/read ui://heph/plan serves the page as an MCP App", async () => {
    const { client: d } = fakeDaemon({});
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("ui://heph/plan");
    const r = await client.readResource({ uri: "ui://heph/plan" });
    expect(r.contents).toHaveLength(1);
    expect(r.contents[0]).toMatchObject({
      uri: "ui://heph/plan",
      mimeType: "text/html;profile=mcp-app",
    });
    expect((r.contents[0] as { text: string }).text).toBe(PLAN_HTML);
    await client.close();
  });

  test("the tool's text and structuredContent are unchanged", async () => {
    const { client: d } = fakeDaemon({ planShow: () => plan });
    const client = await connectTestClient({ client: d, workspace: () => undefined });
    const r = await client.callTool({ name: "heph_plan_show", arguments: { run: "r1" } });
    expect(r.structuredContent).toEqual(plan);
    const text = (r.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("plan p1 of r1 (not approved)");
    expect(text).toContain("order: t1");
    await client.close();
  });
});
