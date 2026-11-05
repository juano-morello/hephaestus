import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHomeConfig } from "../src/config.ts";
import { startDaemon } from "../src/daemon.ts";
import { openHost } from "../src/host.ts";
import { type Io, run } from "../src/main.ts";
import { deps } from "./fixtures/deps.ts";

let root: string;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  rmSync(root, { recursive: true, force: true });
});

async function heph(ws: string, home: string, args: string[]) {
  let out = "";
  const io: Io = { cwd: ws, env: { HEPH_HOME: home }, stdout: (s) => (out += s), stderr: () => {} };
  await run([...args, "--json"], io);
  return JSON.parse(out) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { message: string };
  };
}

/** A daemon in this process with the dashboard listener on (main.ts passes no bundle yet). */
async function daemonWithUi(home: string) {
  const host = openHost({ home, config: await loadHomeConfig(home), daemon: true, deps });
  const d = await startDaemon(host, { home, intervalS: 3600, uiAssets: {} });
  stops.push(() => d.stop());
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
});
