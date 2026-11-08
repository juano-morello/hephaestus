import { describe, expect, test } from "bun:test";
import { buildPlanHtml, buildRunHtml } from "../../../scripts/build-apps.ts";
import { PLAN_HTML, RUN_HTML } from "../../../src/mcp/app/generated.ts";
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
    const methods = f.sent.map((m) => m.method);
    expect(methods.filter((m) => m !== "ui/notifications/size-changed")).toEqual([
      "ui/initialize",
      "ui/notifications/initialized",
    ]);
    expect(methods).toContain("ui/notifications/size-changed");
  });
});

describe("generated run page", () => {
  test("is in sync with its source (run: bun run build:apps)", async () => {
    expect(RUN_HTML).toBe(await buildRunHtml());
  });

  test("is one self-contained file: no external resources, small", () => {
    expect(RUN_HTML).not.toMatch(/(src|href)\s*=/i);
    expect(RUN_HTML).not.toMatch(/https?:\/\//);
    expect(RUN_HTML).not.toContain("@import");
    expect(RUN_HTML.length).toBeLessThan(40_000);
    expect(RUN_HTML.match(/<script>/g)).toHaveLength(1);
  });

  test("the inline script runs against a fake host and renders both shapes", async () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(RUN_HTML)?.[1] ?? "";
    const f = fakeHost();
    new Function(
      "window",
      "document",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
      script,
    )(f.win, f.doc, setInterval, clearInterval, setTimeout, clearTimeout);
    await f.tick();
    f.notify("ui/notifications/tool-result", {
      content: [],
      structuredContent: { runs: [{ run_id: "r4", status: "finished" }] },
    });
    expect(f.body.textContent).toContain("r4");
    f.notify("ui/notifications/tool-result", {
      content: [],
      structuredContent: {
        run: { run_id: "r5", status: "finished" },
        plan_approved: true,
        units: [],
        attempts: [],
        usage: [],
      },
    });
    expect(f.body.textContent).toContain("r5");
    const methods = f.sent
      .map((m) => m.method)
      .filter((m) => m !== "ui/notifications/size-changed");
    expect(methods).toEqual(["ui/initialize", "ui/notifications/initialized"]);
  });
});
