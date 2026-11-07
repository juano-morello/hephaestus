import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHomeConfig } from "../src/config.ts";
import { daemonAt, startDaemon } from "../src/daemon.ts";
import { openHost } from "../src/host.ts";
import {
  challengeAnswer,
  proveListener,
  readUiFile,
  startUiServer,
  UI_METHODS,
  type UiAssets,
  uiFileOf,
} from "../src/ui-server.ts";
import { deps } from "./fixtures/deps.ts";

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

  test("Host variants: only 127.0.0.1:<port> and localhost:<port> are accepted", async () => {
    const ui = await start();
    const get = (host: string) =>
      fetch(`http://127.0.0.1:${ui.port}/`, { headers: { host } }).then((r) => r.status);
    expect(await get(`localhost:${ui.port}`)).toBe(200);
    expect(await get(`127.0.0.1:${ui.port}`)).toBe(200);
    for (const bad of [
      `127.0.0.1:${ui.port + 1}`,
      `localhost.evil:${ui.port}`,
      `LOCALHOST:${ui.port}`,
      "localhost",
      "",
    ])
      expect(await get(bad)).toBe(403);
    // HTTP/1.0 allows no Host header at all
    const raw = await new Promise<string>((resolve) => {
      let got = "";
      Bun.connect({
        hostname: "127.0.0.1",
        port: ui.port,
        socket: {
          open: (s) => void s.write("GET / HTTP/1.0\r\n\r\n"),
          data: (_s, d) => {
            got += d.toString();
          },
          close: () => resolve(got),
        },
      });
    });
    expect(raw.split("\r\n")[0]).toContain("403");
    expect(calls).toEqual([]);
  });

  test("inherited object keys are not methods", async () => {
    const ui = await start();
    for (const m of ["constructor", "__proto__", "toString", "hasOwnProperty"])
      expect((await api(ui, m, { args: [] })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  test("a ui.json weaker than 0600 is tightened and its token replaced", async () => {
    const old = "o".repeat(43);
    writeFileSync(uiFileOf(home), JSON.stringify({ port: 1, token: old }), { mode: 0o644 });
    chmodSync(uiFileOf(home), 0o644);
    const ui = await start();
    expect(ui.token).not.toBe(old);
    expect(statSync(uiFileOf(home)).mode & 0o777).toBe(0o600);
    expect(readUiFile(home)).toEqual({ port: ui.port, token: ui.token });
    expect(readdirSync(home).filter((f) => f !== "ui.json")).toEqual([]);
  });

  test("a malformed ui.json gets a fresh token", async () => {
    writeFileSync(uiFileOf(home), "{not json", { mode: 0o600 });
    const ui = await start();
    expect(ui.token.length).toBeGreaterThanOrEqual(32);
    expect(readUiFile(home)).toEqual({ port: ui.port, token: ui.token });
  });

  test("a chunked body over 1 MB is 400, and size counts bytes not characters", async () => {
    const ui = await start();
    // no content-length: only the byte count of the body itself can stop these
    const chunked = (text: string) =>
      fetch(`http://127.0.0.1:${ui.port}/api/status`, {
        method: "POST",
        headers: { authorization: `Bearer ${ui.token}` },
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(text));
            c.close();
          },
        }),
        duplex: "half",
      });
    expect((await chunked(`{"args":["${"x".repeat(2 * 1024 * 1024)}"]}`)).status).toBe(400);
    // 600k three-byte characters are 600k UTF-16 units but 1.8 MB
    expect((await chunked(JSON.stringify({ args: ["\u20ac".repeat(600_000)] }))).status).toBe(400);
    expect((await chunked(`{"args":["${"x".repeat(1000)}"]}`)).status).toBe(200);
    expect(calls.length).toBe(1);
  });

  test("static responses are not sniffable or frameable; the page has a CSP", async () => {
    const ui = await start();
    const page = await fetch(`http://127.0.0.1:${ui.port}/`);
    const js = await fetch(`http://127.0.0.1:${ui.port}/assets/app.js`);
    for (const r of [page, js]) {
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("script-src 'unsafe");
  });

  test("failing to write ui.json stops the listener and returns undefined", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const port = probe.port as number;
    await probe.stop(true);
    mkdirSync(uiFileOf(home)); // a directory where the file goes makes the rename fail
    const lines: string[] = [];
    const ui = await startUiServer({
      home,
      port,
      assets,
      call: async () => null,
      log: (l) => lines.push(l),
    });
    expect(ui).toBeUndefined();
    expect(lines.join("\n")).toContain("dashboard not started");
    // nothing leaked: the port is free again and no temp file is left
    const again = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("x") });
    await again.stop(true);
    expect(readdirSync(home)).toEqual(["ui.json"]);
  });
});

describe("challenge", () => {
  const nonce = "n".repeat(20);
  const get = (ui: { port: number }, q: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${ui.port}/challenge${q}`, { headers });

  test("challengeAnswer is the HMAC-SHA256 of the nonce under the token", () => {
    const expected = createHmac("sha256", "tok".repeat(12)).update("heph-ui-v1:abc").digest("hex");
    expect(challengeAnswer("tok".repeat(12), "abc")).toBe(expected);
  });

  test("answers a good nonce without a bearer token", async () => {
    const ui = await start();
    const r = await get(ui, `?nonce=${nonce}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ hmac: challengeAnswer(ui.token, nonce) });
    expect(JSON.stringify(await (await get(ui, `?nonce=${nonce}`)).text())).not.toContain(ui.token);
  });

  test("bad nonces are 400 and a wrong Host is 403", async () => {
    const ui = await start();
    for (const q of ["?nonce=abc", `?nonce=${"x".repeat(200)}`, "", `?nonce=${"a/b".repeat(8)}`])
      expect((await get(ui, q)).status).toBe(400);
    expect((await get(ui, `?nonce=${nonce}`, { host: "evil.example" })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("proveListener: true for the real listener, false for foreign ones", async () => {
    const ui = await start();
    expect(await proveListener({ port: ui.port, token: ui.token })).toBe(true);
    expect(await proveListener({ port: ui.port, token: "z".repeat(43) })).toBe(false);
    const wrong = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/challenge"
          ? Response.json({ hmac: "00".repeat(32) })
          : new Response('<div id="root">'),
    });
    const missing = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("nope", { status: 404 }),
    });
    try {
      expect(await proveListener({ port: wrong.port as number, token: ui.token })).toBe(false);
      expect(await proveListener({ port: missing.port as number, token: ui.token })).toBe(false);
    } finally {
      await wrong.stop(true);
      await missing.stop(true);
    }
  });

  test("a ui.json owned by someone else or open to others is not trusted", async () => {
    const old = "o".repeat(43);
    writeFileSync(uiFileOf(home), JSON.stringify({ port: 1, token: old }), { mode: 0o600 });
    const getuid = process.getuid;
    try {
      process.getuid = () => (getuid?.() ?? 0) + 1;
      const ui = await start();
      expect(ui.token).not.toBe(old);
    } finally {
      process.getuid = getuid;
    }
  });

  test("write methods stay 404 with a valid token, new reads need one", async () => {
    const ui = await start();
    expect((await api(ui, "hint", { args: [] })).status).toBe(404);
    expect((await api(ui, "cancel", { args: [] })).status).toBe(404);
    expect((await api(ui, "approvePlan", { args: [] })).status).toBe(404);
  });

  test("the ui.json temp file is created exclusively with a random name", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "ui-server.ts"), "utf8");
    expect(src).toContain('flag: "wx"');
    expect(src).toContain("randomBytes(6)");
  });
});

describe("daemon wiring", () => {
  async function host() {
    return openHost({ home, config: await loadHomeConfig(home), daemon: true, deps });
  }

  test("stop() stops the UI listener", async () => {
    const d = await startDaemon(await host(), { home, intervalS: 3600, uiAssets: assets });
    const port = d.ui?.port as number;
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    await d.stop();
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  test("the daemon starts without a UI when the listener cannot start", async () => {
    mkdirSync(uiFileOf(home));
    const lines: string[] = [];
    const d = await startDaemon(await host(), {
      home,
      intervalS: 3600,
      uiAssets: assets,
      log: (l) => lines.push(l),
    });
    try {
      expect(d.ui).toBeUndefined();
      expect(await daemonAt(home)).toBeDefined();
      expect(lines.join("\n")).toContain("dashboard not started");
    } finally {
      await d.stop();
    }
  });

  test("a taken UI port falls back and the daemon still serves", async () => {
    const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const d = await startDaemon(await host(), {
      home,
      intervalS: 3600,
      uiAssets: assets,
      uiPort: taken.port as number,
    });
    try {
      expect(d.ui?.port).not.toBe(taken.port);
      expect(await daemonAt(home)).toBeDefined();
    } finally {
      await d.stop();
      await taken.stop(true);
    }
  });

  test("a failing startup leaves neither the socket nor the UI running", async () => {
    const h = await host();
    const broken = Object.create(h, {
      resumeOnStart: { value: async () => Promise.reject(new Error("resume failed")) },
    });
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const port = probe.port as number;
    await probe.stop(true);
    await expect(
      startDaemon(broken, { home, intervalS: 3600, uiAssets: assets, uiPort: port }),
    ).rejects.toThrow("resume failed");
    expect(await daemonAt(home)).toBeUndefined();
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    expect(existsSync(join(home, "daemon.sock"))).toBe(false);
  });
});
