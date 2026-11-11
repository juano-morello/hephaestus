import { describe, expect, test } from "bun:test";
import { UI_METHODS, type UiAssets, uiHandler } from "../src/ui-server.ts";

const token = "t".repeat(43);
const PORT = 7878;
const assets: UiAssets = { "/": { body: "<html>index</html>", type: "text/html; charset=utf-8" } };

const handler = () => {
  const calls: { method: string; args: unknown[] }[] = [];
  const h = uiHandler({
    token,
    port: () => PORT,
    assets,
    call: async (method, args) => {
      calls.push({ method, args });
      return { method };
    },
  });
  return { h, calls };
};

const req = (path: string, init: RequestInit & { host?: string } = {}) => {
  const { host = `127.0.0.1:${PORT}`, headers, ...rest } = init;
  return new Request(`http://127.0.0.1:${PORT}${path}`, {
    ...rest,
    headers: { host, ...(headers as Record<string, string>) },
  });
};

describe("the dashboard request handler, CORS for the widgets", () => {
  test("a preflight to /api/<method> allows POST with authorization and content-type", async () => {
    const { h, calls } = handler();
    const r = await h(
      req("/api/status", {
        method: "OPTIONS",
        headers: {
          origin: "https://widget.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      }),
    );
    expect(r.status).toBeGreaterThanOrEqual(200);
    expect(r.status).toBeLessThan(300);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("access-control-allow-methods")).toContain("POST");
    const allowed = (r.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).toContain("authorization");
    expect(allowed).toContain("content-type");
    expect(calls).toEqual([]);
  });

  test("a preflight that asks for private network access is granted it", async () => {
    const { h } = handler();
    const r = await h(
      req("/api/status", {
        method: "OPTIONS",
        headers: { origin: "https://w.example", "access-control-request-private-network": "true" },
      }),
    );
    expect(r.headers.get("access-control-allow-private-network")).toBe("true");
  });

  test("a POST without the token is still 401, and with it the answer is readable cross-origin", async () => {
    const { h, calls } = handler();
    const body = JSON.stringify({ args: [] });
    const no = await h(req("/api/status", { method: "POST", body }));
    expect(no.status).toBe(401);
    const ok = await h(
      req("/api/status", {
        method: "POST",
        body,
        headers: { authorization: `Bearer ${token}`, origin: "https://w.example" },
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect(calls).toEqual([{ method: "status", args: [] }]);
  });

  test("a foreign Host header is still 403, preflight included", async () => {
    const { h } = handler();
    const pre = await h(req("/api/status", { method: "OPTIONS", host: "evil.example" }));
    expect(pre.status).toBe(403);
    const post = await h(
      req("/api/status", {
        method: "POST",
        host: "evil.example",
        body: "{}",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(post.status).toBe(403);
  });

  test("a static asset response has no Access-Control headers", async () => {
    const { h } = handler();
    const r = await h(req("/"));
    expect(r.status).toBe(200);
    expect([...r.headers.keys()].filter((k) => k.startsWith("access-control"))).toEqual([]);
    const pre = await h(req("/", { method: "OPTIONS", headers: { origin: "https://w.example" } }));
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("the methods are the read-only allowlist: any other is 404 with the token", async () => {
    const { h, calls } = handler();
    for (const m of ["approve", "cancel", "hint", "run", "new"]) {
      const r = await h(
        req(`/api/${m}`, {
          method: "POST",
          body: JSON.stringify({ args: [] }),
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(r.status).toBe(404);
    }
    expect(calls).toEqual([]);
    expect([...UI_METHODS]).toEqual([
      "status",
      "explain",
      "planShow",
      "dashboard",
      "planDetail",
      "diffSummary",
      "runCharts",
      "overview",
    ]);
  });
});
