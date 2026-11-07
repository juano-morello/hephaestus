import { describe, expect, test } from "bun:test";
import { mountPlan } from "../../../src/mcp/app/plan.ts";
import { type FakeEl, fakeHost } from "./fake-dom.ts";

const task = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  kind: "feature",
  project: "app",
  lane: "fast",
  complexity: "low",
  scope: [`src/${id}.ts`],
  covers: ["AC1"],
  ...over,
});
const plan = (over: Record<string, unknown> = {}) => ({
  run_id: "r7",
  plan_id: "p3",
  approved: false,
  order: ["t1", "t2"],
  tasks: [task("t1"), task("t2", { scope: [], covers: [] })],
  risks: ["flaky network"],
  ...over,
});

async function render(structuredContent?: unknown, text = "plain text result", hostOpts = {}) {
  const f = fakeHost(hostOpts);
  mountPlan(f.win as never, f.doc as never);
  await f.tick();
  f.notify("ui/notifications/tool-input", { arguments: { run: "r7" } });
  f.notify("ui/notifications/tool-result", {
    content: [{ type: "text", text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  });
  return f;
}
const all = (f: { body: FakeEl }) => f.body.textContent;

describe("plan widget", () => {
  test("shows ids, badge, cards in build order, risks and the approval note", async () => {
    const f = await render(plan({ order: ["t2", "t1"] }));
    const t = all(f);
    expect(t).toContain("r7");
    expect(t).toContain("p3");
    expect(t).toContain("waiting for your approval");
    expect(t).toContain("heph approve plan r7");
    expect(t).toContain("flaky network");
    const cards = f.body.byClass("task");
    expect(cards.map((c) => c.byClass("task-id")[0]?.textContent)).toEqual(["t2", "t1"]);
    expect(cards[1]?.textContent).toContain("Task t1");
    expect(cards[1]?.textContent).toContain("src/t1.ts");
    expect(cards[1]?.textContent).toContain("AC1");
  });

  test("approved plan says approved and does not ask for approval", async () => {
    const f = await render(plan({ approved: true }));
    expect(all(f)).toContain("approved");
    expect(all(f)).not.toContain("waiting for your approval");
    expect(all(f)).toContain("outside the chat");
  });

  test("has no actions: no buttons or inputs, no approve control", async () => {
    const f = await render(plan());
    expect(f.body.find((e) => ["button", "input", "a", "form"].includes(e.tag))).toEqual([]);
  });

  test("an empty plan renders without cards or risks", async () => {
    const f = await render(plan({ order: [], tasks: [], risks: [] }));
    expect(f.body.byClass("task")).toHaveLength(0);
    expect(all(f)).toContain("No tasks");
    expect(all(f)).not.toContain("Risks");
  });

  test("many tasks render one card each; ids missing from order still show last", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `t${i}`);
    const f = await render(plan({ order: ids.slice(0, 59), tasks: ids.map((i) => task(i)) }));
    const cards = f.body.byClass("task");
    expect(cards).toHaveLength(60);
    expect(cards[59]?.byClass("task-id")[0]?.textContent).toBe("t59");
  });

  test("falls back to the text content when structuredContent is missing or malformed", async () => {
    for (const sc of [undefined, { nope: 1 }, "str"]) {
      const f = await render(sc, "plan p3 of r7 (not approved)");
      expect(all(f)).toContain("plan p3 of r7 (not approved)");
      expect(f.body.byClass("task")).toHaveLength(0);
    }
  });

  test("hostile strings stay inert text", async () => {
    const evil = `<img src=x onerror=alert(1)>`;
    const f = await render(
      plan({
        run_id: evil,
        plan_id: "</script><script>alert(2)</script>",
        order: ["t1"],
        tasks: [task("t1", { title: "</script><b>x</b>", scope: [evil], covers: [evil] })],
        risks: [evil],
      }),
    );
    expect(f.body.find((e) => e.tag === "img" || e.tag === "script" || e.tag === "b")).toEqual([]);
    expect(all(f)).toContain(evil);
    expect(all(f)).toContain("</script><b>x</b>");
  });

  test("hostile text in the fallback path is inert too", async () => {
    const f = await render(undefined, "<img src=x onerror=alert(1)>");
    expect(f.body.find((e) => e.tag === "img")).toEqual([]);
  });

  test("a later result replaces the earlier render", async () => {
    const f = await render(plan());
    f.notify("ui/notifications/tool-result", {
      content: [],
      structuredContent: plan({ run_id: "r9", tasks: [task("t1")], order: ["t1"] }),
    });
    expect(all(f)).toContain("r9");
    expect(f.body.byClass("task")).toHaveLength(1);
  });

  test("applies host colours", async () => {
    const f = await render(plan(), "x", { variables: { "--color-text-primary": "#abc" } });
    expect(f.root.style.props["--color-text-primary"]).toBe("#abc");
  });

  test("shows a waiting message until the result arrives, and a note if the host never speaks", async () => {
    const f = fakeHost();
    mountPlan(f.win as never, f.doc as never);
    expect(all(f)).toContain("Waiting");
  });
});
