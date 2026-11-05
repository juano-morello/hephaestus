import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readUiFile,
  startUiServer,
  UI_METHODS,
  type UiAssets,
  uiFileOf,
} from "../src/ui-server.ts";

let home: string;
let calls: { method: string; args: unknown[] }[];
const stops: (() => Promise<void>)[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "heph-ui-"));
  calls = [];
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  rmSync(home, { recursive: true, force: true });
});

const assets: UiAssets = {
  "/": { body: "<html>index</html>", type: "text/html; charset=utf-8" },
  "/assets/app.js": { body: "console.log(1)", type: "text/javascript; charset=utf-8" },
};

async function start(port = 0) {
  const ui = await startUiServer({
    home,
    port,
    assets,
    call: async (method, args) => {
      calls.push({ method, args });
      if (args[0] === "boom") throw new Error("boom failed");
      return { method, args };
    },
  });
  if (!ui) throw new Error("no listener");
  stops.push(ui.stop);
  return ui;
}

const api = (ui: { port: number; token: string }, m: string, body: unknown, token?: string) =>
  fetch(`http://127.0.0.1:${ui.port}/api/${m}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token ?? ui.token}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("ui server", () => {
  test("serves the bundle without a token", async () => {
    const ui = await start();
    const index = await fetch(`http://127.0.0.1:${ui.port}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toBe("<html>index</html>");
    const js = await fetch(`http://127.0.0.1:${ui.port}/assets/app.js`);
    expect(await js.text()).toBe("console.log(1)");
    expect(js.headers.get("content-type")).toContain("javascript");
  });

  test("api without a token is 401, with a wrong token is 401", async () => {
    const ui = await start();
    const none = await fetch(`http://127.0.0.1:${ui.port}/api/status`, { method: "POST" });
    expect(none.status).toBe(401);
    expect((await api(ui, "status", { args: [] }, "wrong")).status).toBe(401);
    expect((await api(ui, "status", { args: [] }, "x".repeat(ui.token.length))).status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("a wrong Host header is 403", async () => {
    const ui = await start();
    for (const [path, method] of [
      ["/", "GET"],
      ["/api/status", "POST"],
    ] as const) {
      const r = await fetch(`http://127.0.0.1:${ui.port}${path}`, {
        method,
        headers: { host: "evil.example:7878", authorization: `Bearer ${ui.token}` },
      });
      expect(r.status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  test("only the four read methods are routable", async () => {
    expect([...UI_METHODS]).toEqual(["status", "explain", "planShow", "dashboard"]);
    const ui = await start();
    for (const m of "newRun revise run hint cancel approve merge handoff adopt sync".split(" "))
      expect((await api(ui, m, { args: [] })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  test("an allowlisted method passes args and returns data", async () => {
    const ui = await start();
    const r = await api(ui, "status", { args: ["r-1"] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, data: { method: "status", args: ["r-1"] } });
    expect(calls).toEqual([{ method: "status", args: ["r-1"] }]);
    const bad = await api(ui, "explain", { args: ["boom"] });
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({ ok: false, error: { message: "boom failed" } });
  });

  test("a non-JSON or oversized body is 400 and the server keeps serving", async () => {
    const ui = await start();
    expect((await api(ui, "status", "x".repeat(2 * 1024 * 1024))).status).toBe(400);
    expect((await api(ui, "status", "not json")).status).toBe(400);
    expect((await api(ui, "status", { args: "nope" })).status).toBe(400);
    expect((await api(ui, "status", { args: [] })).status).toBe(200);
  });

  test("GET /api/status is 405", async () => {
    const ui = await start();
    const r = await fetch(`http://127.0.0.1:${ui.port}/api/status`);
    expect(r.status).toBe(405);
  });

  test("no CORS headers on any response", async () => {
    const ui = await start();
    const rs = [
      await fetch(`http://127.0.0.1:${ui.port}/`),
      await fetch(`http://127.0.0.1:${ui.port}/api/status`),
      await fetch(`http://127.0.0.1:${ui.port}/api/status`, { method: "OPTIONS" }),
      await api(ui, "status", { args: [] }),
      await fetch(`http://127.0.0.1:${ui.port}/nope`),
    ];
    for (const r of rs)
      for (const [k] of r.headers)
        expect(k.toLowerCase().startsWith("access-control-")).toBe(false);
  });

  test("ui.json is written with mode 0600 and the real port", async () => {
    const ui = await start();
    const file = uiFileOf(home);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ port: ui.port, token: ui.token });
    expect(readUiFile(home)).toEqual({ port: ui.port, token: ui.token });
    expect(readUiFile(join(home, "missing"))).toBeUndefined();
  });

  test("the token survives a restart", async () => {
    const first = await start();
    await first.stop();
    const second = await start();
    expect(second.token).toBe(first.token);
  });

  test("a taken port falls back to another and ui.json says which", async () => {
    const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    try {
      const ui = await start(taken.port);
      expect(ui.port).not.toBe(taken.port);
      expect(readUiFile(home)?.port).toBe(ui.port);
      expect((await fetch(`http://127.0.0.1:${ui.port}/`)).status).toBe(200);
    } finally {
      await taken.stop(true);
    }
  });
});
