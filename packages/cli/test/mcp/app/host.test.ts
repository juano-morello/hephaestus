import { describe, expect, test } from "bun:test";
import { connectHost } from "../../../src/mcp/app/host.ts";
import { fakeHost } from "./fake-dom.ts";

describe("the MCP App host helper", () => {
  test("handshake: ui/initialize, then the initialized notification", async () => {
    const f = fakeHost();
    const host = connectHost(f.win as never, f.doc as never, { name: "heph-test", version: "9" });
    await host.ready;
    expect(f.sent[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "ui/initialize",
      params: {
        appInfo: { name: "heph-test", version: "9" },
        appCapabilities: {},
        protocolVersion: "2026-01-26",
      },
    });
    expect(f.sent[1]).toMatchObject({ method: "ui/notifications/initialized" });
    expect(f.sent[1]?.id).toBeUndefined();
  });

  test("hasServerTools follows the host's serverTools capability", async () => {
    for (const [caps, want] of [
      [{ serverTools: {} }, true],
      [{ serverTools: { listChanged: true } }, true],
      [{}, false],
      [{ openLinks: {} }, false],
    ] as const) {
      const f = fakeHost({ hostCapabilities: caps });
      const host = connectHost(f.win as never, f.doc as never, { name: "t", version: "1" });
      await host.ready;
      expect(host.hasServerTools).toBe(want);
    }
  });

  test("host CSS variables land on :root; non-variables and non-strings are ignored", async () => {
    const f = fakeHost({
      theme: "dark",
      variables: { "--color-background-primary": "#111", color: "red", "--bad": 3 as never },
    });
    const host = connectHost(f.win as never, f.doc as never, { name: "t", version: "1" });
    await host.ready;
    expect(f.root.style.props).toEqual({
      "--color-background-primary": "#111",
      "color-scheme": "dark",
    });
    expect(f.root.attrs["data-theme"]).toBe("dark");
  });

  test("tool-result and context-change notifications reach the handlers", async () => {
    const f = fakeHost();
    const host = connectHost(f.win as never, f.doc as never, { name: "t", version: "1" });
    const results: unknown[] = [];
    host.onToolResult((r) => results.push(r));
    await host.ready;
    f.notify("ui/notifications/tool-result", {
      content: [{ type: "text", text: "hi" }],
      structuredContent: { a: 1 },
    });
    expect(results).toEqual([
      { content: [{ type: "text", text: "hi" }], structuredContent: { a: 1 } },
    ]);
    f.notify("ui/notifications/host-context-changed", {
      styles: { variables: { "--x": "1" } },
      theme: "dark",
    });
    expect(f.root.style.props["--x"]).toBe("1");
    expect(f.root.attrs["data-theme"]).toBe("dark");
  });

  test("a result that arrives before the handler is registered is not lost", async () => {
    const f = fakeHost();
    const host = connectHost(f.win as never, f.doc as never, { name: "t", version: "1" });
    await host.ready;
    f.notify("ui/notifications/tool-result", { content: [] });
    const got: unknown[] = [];
    host.onToolResult((r) => got.push(r));
    expect(got).toHaveLength(1);
  });

  test("host requests are answered with an empty result; messages from other windows are ignored", async () => {
    const f = fakeHost();
    const host = connectHost(f.win as never, f.doc as never, { name: "t", version: "1" });
    await host.ready;
    const before = f.sent.length;
    f.deliver({ jsonrpc: "2.0", id: 77, method: "ui/resource-teardown", params: {} });
    expect(f.sent[before]).toEqual({ jsonrpc: "2.0", id: 77, result: {} });
    const got: unknown[] = [];
    host.onToolResult((r) => got.push(r));
    f.deliver(
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [] } },
      { other: true },
    );
    f.deliver("not an object");
    f.deliver(null);
    expect(got).toHaveLength(0);
    expect(f.sent.length).toBe(before + 1);
  });

  test("a refused initialize rejects ready", async () => {
    const f = fakeHost({ silent: true });
    const host = connectHost(f.win as never, f.doc as never, { name: "t", version: "1" });
    await f.tick();
    f.deliver({ jsonrpc: "2.0", id: f.sent[0]?.id, error: { code: -32601, message: "nope" } });
    await expect(host.ready).rejects.toThrow("nope");
  });

  test("string ids on host requests are answered too", async () => {
    const f = fakeHost();
    const host = connectHost(f.win as never, f.doc as never, { name: "t", version: "1" });
    await host.ready;
    f.deliver({ jsonrpc: "2.0", id: "abc", method: "ui/resource-teardown", params: {} });
    expect(f.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: "abc", result: {} });
  });

  test("the host's theme sets color-scheme", async () => {
    const f = fakeHost({ theme: "dark" });
    const host = connectHost(f.win as never, f.doc as never, { name: "t", version: "1" });
    await host.ready;
    expect(f.root.style.props["color-scheme"]).toBe("dark");
  });

  test("reportSize sends size-changed with the document size, unless the host fixed the height", async () => {
    const f = fakeHost();
    const host = connectHost(f.win as never, f.doc as never, { name: "t", version: "1" });
    await host.ready;
    host.reportSize();
    expect(f.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { width: 320, height: 480 },
    });
    const g = fakeHost({ containerDimensions: { height: 600 } });
    const fixed = connectHost(g.win as never, g.doc as never, { name: "t", version: "1" });
    await fixed.ready;
    const n = g.sent.length;
    fixed.reportSize();
    expect(g.sent.length).toBe(n);
  });
});
