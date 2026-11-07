import { describe, expect, test } from "bun:test";
import { buildPlanHtml } from "../../../scripts/build-apps.ts";
import { PLAN_HTML } from "../../../src/mcp/app/generated.ts";
import { fakeHost } from "./fake-dom.ts";

describe("generated plan page", () => {
  test("is in sync with its source (run: bun run build:apps)", async () => {
    expect(PLAN_HTML).toBe(await buildPlanHtml());
  });

  test("is one self-contained file: no external resources, small", () => {
    expect(PLAN_HTML).not.toMatch(/(src|href)\s*=/i);
    expect(PLAN_HTML).not.toMatch(/https?:\/\//);
    expect(PLAN_HTML).not.toContain("@import");
    expect(PLAN_HTML.length).toBeLessThan(20_000);
    expect(PLAN_HTML.match(/<script>/g)).toHaveLength(1);
  });

  test("the inline script runs against a fake host and renders", async () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(PLAN_HTML)?.[1] ?? "";
    const f = fakeHost();
    new Function("window", "document", script)(f.win, f.doc);
    await f.tick();
    f.notify("ui/notifications/tool-result", {
      content: [],
      structuredContent: {
        run_id: "r1",
        plan_id: "p1",
        approved: true,
        order: [],
        tasks: [],
        risks: [],
      },
    });
    expect(f.body.textContent).toContain("r1");
    expect(f.sent.map((m) => m.method)).toEqual(["ui/initialize", "ui/notifications/initialized"]);
  });
});
