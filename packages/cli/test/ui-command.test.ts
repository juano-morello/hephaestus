import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHomeConfig } from "../src/config.ts";
import { startDaemon } from "../src/daemon.ts";
import { openHost } from "../src/host.ts";
import { type Io, opener, run } from "../src/main.ts";
import type { UiAssets } from "../src/ui-server.ts";
import { deps } from "./fixtures/deps.ts";

let root: string;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  rmSync(root, { recursive: true, force: true });
});

async function heph(ws: string, home: string, args: string[], extra: Partial<Io> = {}) {
  let out = "";
  const io: Io = {
    cwd: ws,
    env: { HEPH_HOME: home },
    stdout: (s) => (out += s),
    stderr: () => {},
    ...extra,
  };
  await run([...args, "--json"], io);
  return JSON.parse(out) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { message: string };
  };
}

const PAGE = '<!doctype html><title>Hephaestus</title><div id="root"></div>';
const page = (body = PAGE): UiAssets => ({ "/": { body, type: "text/html; charset=utf-8" } });

/** A daemon in this process with the dashboard listener on, serving the given assets. */
async function daemonWithUi(home: string, assets: UiAssets = page()) {
  const host = openHost({ home, config: await loadHomeConfig(home), daemon: true, deps });
  const d = await startDaemon(host, { home, intervalS: 3600, uiAssets: assets });
  stops.push(() => d.stop());
  return d;
}

function setup() {
  root = mkdtempSync(join(tmpdir(), "heph-ui-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), "node: { id: test-node }\nsandbox: { mode: native }\n");
  return { ws: root, home };
}

describe("heph ui", () => {
  test("prints the url from ui.json when the daemon answers", async () => {
    const { ws, home } = setup();
    await daemonWithUi(home);
    const r = await heph(ws, home, ["ui", "--no-open"]);
    expect(r).toMatchObject({ ok: true });
    const ui = JSON.parse(readFileSync(join(home, "ui.json"), "utf8")) as {
      port: number;
      token: string;
    };
    expect(r.data?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#t=[\w-]+$/);
    expect(r.data?.url).toBe(`http://127.0.0.1:${ui.port}/#t=${ui.token}`);
    expect(r.data?.opened).toBe(false);
  });

  test("with no daemon fails and says to run heph doctor", async () => {
    const { ws, home } = setup();
    const r = await heph(ws, home, ["ui", "--no-open"]);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("heph doctor");
  });

  test("with a stale ui.json fails the same way", async () => {
    const { ws, home } = setup();
    writeFileSync(join(home, "ui.json"), JSON.stringify({ port: 1, token: "a".repeat(43) }));
    const r = await heph(ws, home, ["ui", "--no-open"]);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("heph doctor");
    expect(JSON.stringify(r)).not.toContain("#t=");
  });

  test("a live daemon with ui.json pointing at a dead port fails with no url", async () => {
    const { ws, home } = setup();
    await daemonWithUi(home);
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const dead = probe.port as number;
    await probe.stop(true);
    writeFileSync(join(home, "ui.json"), JSON.stringify({ port: dead, token: "a".repeat(43) }));
    const r = await heph(ws, home, ["ui", "--no-open"]);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("heph doctor");
    expect(JSON.stringify(r)).not.toContain("#t=");
  });

  test("a listener with no bundle (404) or a foreign page is not the dashboard", async () => {
    for (const assets of [{}, page("<html>something else</html>")]) {
      const { ws, home } = setup();
      const d = await daemonWithUi(home, assets);
      const r = await heph(ws, home, ["ui", "--no-open"]);
      expect(r.ok).toBe(false);
      expect(r.error?.message).toContain("heph doctor");
      await d.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a foreign listener serving the root element gets no token and heph ui refuses", async () => {
    const { ws, home } = setup();
    await daemonWithUi(home);
    const seen: { url: string; auth: string | null }[] = [];
    const token = "f".repeat(43);
    const foreign = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        seen.push({ url: req.url, auth: req.headers.get("authorization") });
        return new Response(PAGE);
      },
    });
    try {
      writeFileSync(join(home, "ui.json"), JSON.stringify({ port: foreign.port, token }), {
        mode: 0o600,
      });
      const r = await heph(ws, home, ["ui", "--no-open"]);
      expect(r.ok).toBe(false);
      expect(r.error?.message).toBe(
        `the dashboard listener on port ${foreign.port} is not this node's daemon (a stale ui.json?); restart it with heph daemon, or run heph doctor`,
      );
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((s) => s.auth === null && !s.url.includes(token))).toBe(true);
      expect(JSON.stringify(r)).not.toContain("#t=");
    } finally {
      await foreign.stop(true);
    }
  });

  test("a ui.json open to group or others is not trusted by heph ui", async () => {
    const { ws, home } = setup();
    await daemonWithUi(home);
    const file = join(home, "ui.json");
    const { token } = JSON.parse(readFileSync(file, "utf8")) as { token: string };
    chmodSync(file, 0o644);
    const r = await heph(ws, home, ["ui", "--no-open"]);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("heph doctor");
    expect(JSON.stringify(r)).not.toContain(token);
  });

  test("opens the url only on a TTY without --no-open, with the platform's opener", async () => {
    const { ws, home } = setup();
    await daemonWithUi(home);
    const opened: string[][] = [];
    const open = (argv: string[]) => void opened.push(argv);
    const cases: [string[], Partial<Io>, boolean][] = [
      [["ui"], { tty: true, platform: "darwin", open }, true],
      [["ui", "--no-open"], { tty: true, platform: "darwin", open }, false],
      [["ui"], { tty: false, platform: "darwin", open }, false],
    ];
    for (const [args, extra, expected] of cases) {
      opened.length = 0;
      const r = await heph(ws, home, args, extra);
      expect(r.data?.opened).toBe(expected);
      expect(opened.length).toBe(expected ? 1 : 0);
      if (expected) expect(opened[0]).toEqual(["open", r.data?.url as string]);
    }
    opened.length = 0;
    await heph(ws, home, ["ui"], { tty: true, platform: "linux", open });
    expect(opened[0]?.[0]).toBe("xdg-open");
  });

  test("a failing opener does not fail the command", async () => {
    const { ws, home } = setup();
    await daemonWithUi(home);
    const r = await heph(ws, home, ["ui"], {
      tty: true,
      platform: "linux",
      open: () => {
        throw new Error("no xdg-open");
      },
    });
    expect(r).toMatchObject({ ok: true, data: { opened: false } });
  });

  test("the opener command per platform", () => {
    expect(opener("darwin", "http://x")).toEqual(["open", "http://x"]);
    expect(opener("linux", "http://x")).toEqual(["xdg-open", "http://x"]);
  });

  test("every compiled build builds the dashboard bundle first", () => {
    const scripts = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "..", "package.json"), "utf8"),
    ).scripts as Record<string, string>;
    for (const k of ["build:heph", "build:heph:linux"])
      expect(scripts[k]?.startsWith("bun run build:ui && ")).toBe(true);
  });
});
