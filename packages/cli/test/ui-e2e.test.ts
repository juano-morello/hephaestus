// The dashboard against a real daemon process: the embedded bundle, a run built by the scripted
// worker, and the token and read-only allowlist as a browser would meet them.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { daemonAt } from "../src/daemon.ts";
import { type Io, run } from "../src/main.ts";
import { Dashboard } from "../src/output.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const DEPS = join(import.meta.dir, "fixtures", "deps.ts");
const UI_DIR = join(import.meta.dir, "..", "..", "ui");
let root: string;
const daemons: ReturnType<typeof Bun.spawn>[] = [];

beforeAll(() => {
  // The daemon embeds packages/ui/dist; build it when it is missing.
  if (!existsSync(join(UI_DIR, "dist", "index.html"))) {
    const r = Bun.spawnSync(["bun", "run", "build:ui"], { cwd: join(UI_DIR, "..", "..") });
    if (r.exitCode !== 0) throw new Error(`build:ui failed: ${r.stderr.toString()}`);
  }
}, 120_000);

afterEach(async () => {
  for (const d of daemons.splice(0)) {
    d.kill("SIGKILL");
    await d.exited;
  }
  rmSync(root, { recursive: true, force: true });
});

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

async function startDaemon(home: string) {
  const d = Bun.spawn(["bun", MAIN, "daemon"], {
    env: { ...process.env, HEPH_HOME: home, HEPH_DEPS_MODULE: DEPS, HEPH_TEST_WORKER_MS: "0" },
    stdout: "ignore",
    stderr: "pipe",
  });
  daemons.push(d);
  for (let i = 0; i < 100 && !(await daemonAt(home)); i++) await Bun.sleep(100);
  if (!(await daemonAt(home))) throw new Error("the daemon did not start");
  return d;
}

async function heph(ws: string, home: string, args: string[]) {
  let out = "";
  const io: Io = { cwd: ws, env: { HEPH_HOME: home }, stdout: (s) => (out += s), stderr: () => {} };
  await run([...args, "--json"], io);
  return JSON.parse(out) as { ok: boolean; data?: Record<string, unknown> };
}

const uiOf = (home: string) =>
  JSON.parse(readFileSync(join(home, "ui.json"), "utf8")) as { port: number; token: string };

async function setup() {
  root = mkdtempSync(join(tmpdir(), "heph-e2e-"));
  const ws = join(root, "calc");
  const home = join(root, "home");
  put(join(ws, "README.md"), "# calc\n");
  for (const cmd of [
    ["git", "init", "-q", "-b", "main"],
    ["git", "-c", "user.name=T", "-c", "user.email=t@x", "add", "-A"],
    ["git", "-c", "user.name=T", "-c", "user.email=t@x", "commit", "-qm", "base"],
  ])
    Bun.spawnSync(cmd, { cwd: ws });
  put(join(home, "config.yaml"), "node: { id: test-node }\nsandbox: { mode: native }\n");
  put(
    join(root, "brief.yaml"),
    `schema: 1
source: cli
goal: add.sh prints the sum of two integers
context: ""
decisions: [Usage is sh add.sh A B]
constraints: [POSIX sh only]
acceptance:
  - { id: AC1, text: "sh add.sh 2 3 prints 5", kind: behavior }
out_of_scope: []
open_questions: []
`,
  );
  await heph(ws, home, ["init"]);
  put(
    join(ws, ".heph", "config.yaml"),
    "projects:\n  calc:\n    commands: { test: sh test_add.sh }\n",
  );
  return { ws, home };
}

const post = (ui: { port: number }, method: string, args: unknown[], token?: string) =>
  fetch(`http://127.0.0.1:${ui.port}/api/${method}`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ args }),
  });

describe("dashboard end to end", () => {
  test("serves a real run end to end", async () => {
    const { ws, home } = await setup();
    await startDaemon(home);
    expect(
      (await heph(ws, home, ["new", "--brief", join(root, "brief.yaml"), "--run-id", "R1"])).data,
    ).toMatchObject({ status: "planned" });
    await heph(ws, home, ["approve", "plan", "R1"]);
    expect((await heph(ws, home, ["run", "R1"])).data).toMatchObject({ status: "staged" });

    const ui = uiOf(home);
    expect(statSync(join(home, "ui.json")).mode & 0o777).toBe(0o600);

    const page = await fetch(`http://127.0.0.1:${ui.port}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<div id="root">');
    expect(html).toContain("Hephaestus");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`http://127.0.0.1:${ui.port}/assets/app.js`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${ui.port}/assets/app.css`)).status).toBe(200);

    const status = (await (await post(ui, "status", [], ui.token)).json()) as {
      ok: boolean;
      data: { runs: { run_id: string }[] };
    };
    expect(status.ok).toBe(true);
    expect(status.data.runs.map((r) => r.run_id)).toEqual(["R1"]);

    const dash = (await (await post(ui, "dashboard", ["R1"], ui.token)).json()) as {
      ok: boolean;
      data: unknown;
    };
    expect(dash.ok).toBe(true);
    const parsed = Dashboard.parse(dash.data);
    expect(parsed.run.status).toBe("staged");
    expect(parsed.plan.units.map((u) => u.id)).toEqual(["T1", "T2"]);
    expect(parsed.plan_approved).toBe(true);
    expect(parsed.attempts.length).toBeGreaterThan(0);

    // writes are not on the network surface, with or without the token
    expect((await post(ui, "approve", ["R1"], ui.token)).status).toBe(404);
    expect((await post(ui, "approve", ["R1"])).status).toBe(401);
    for (const [m, args] of [
      ["status", []],
      ["dashboard", ["R1"]],
    ] as const)
      expect((await post(ui, m, [...args])).status).toBe(401);
    expect((await post(ui, "status", [], "wrong")).status).toBe(401);
  }, 90_000);

  test("the token and port file survive a daemon restart", async () => {
    const { home } = await setup();
    const first = await startDaemon(home);
    const before = uiOf(home);
    first.kill("SIGTERM");
    await first.exited;
    await startDaemon(home);
    const after = uiOf(home);
    expect(after.token).toBe(before.token);
    expect(statSync(join(home, "ui.json")).mode & 0o777).toBe(0o600);
    expect((await post(after, "status", [], before.token)).status).toBe(200);
  }, 60_000);
});
