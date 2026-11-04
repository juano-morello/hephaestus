import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { daemonAt } from "../src/daemon.ts";
import { type Io, run } from "../src/main.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const DEPS = join(import.meta.dir, "fixtures", "deps.ts");
let root: string;
const daemons: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => {
  for (const d of daemons.splice(0)) d.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

async function startDaemon(home: string, workerMs: number) {
  const d = Bun.spawn(["bun", MAIN, "daemon"], {
    env: {
      ...process.env,
      HEPH_HOME: home,
      HEPH_DEPS_MODULE: DEPS,
      HEPH_TEST_WORKER_MS: String(workerMs),
    },
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
  const io: Io = {
    cwd: ws,
    env: { HEPH_HOME: home },
    stdout: (s) => {
      out += s;
    },
    stderr: () => {},
  };
  await run([...args, "--json"], io);
  return JSON.parse(out) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { message: string };
  };
}

async function setup() {
  root = mkdtempSync(join(tmpdir(), "heph-daemon-"));
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

describe("heph daemon", () => {
  test("the CLI goes through a running daemon, which builds the run as a job", async () => {
    const { ws, home } = await setup();
    await startDaemon(home, 0);
    expect(
      (await heph(ws, home, ["new", "--brief", join(root, "brief.yaml"), "--run-id", "R1"])).data,
    ).toMatchObject({
      status: "planned",
      node: "test-node",
    });
    await heph(ws, home, ["approve", "plan", "R1"]);
    expect((await heph(ws, home, ["run", "R1"])).data).toMatchObject({
      run_id: "R1",
      status: "staged",
    });
  }, 60_000);

  test("a daemon killed mid-build resumes the run on its own when it starts again", async () => {
    const { ws, home } = await setup();
    const first = await startDaemon(home, 1500);
    await heph(ws, home, ["new", "--brief", join(root, "brief.yaml"), "--run-id", "R2"]);
    await heph(ws, home, ["approve", "plan", "R2"]);
    // Start the build without following it, then kill the daemon while T1 is in its worker.
    const d = await daemonAt(home);
    await d?.call("run", ["R2", {}], ws);
    for (let i = 0; i < 50; i++) {
      const s = await heph(ws, home, ["status", "R2"]);
      if ((s.data?.attempts as unknown[] | undefined)?.length) break;
      await Bun.sleep(100);
    }
    first.kill("SIGKILL");
    await first.exited;

    await startDaemon(home, 0);
    let status = "";
    for (let i = 0; i < 300 && status !== "staged"; i++) {
      const run = (await heph(ws, home, ["status", "R2"])).data?.run as
        | { status: string }
        | undefined;
      status = run?.status ?? "";
      await Bun.sleep(100);
    }
    expect(status).toBe("staged");
    const events = (await heph(ws, home, ["explain", "R2"])).data?.events as {
      type: string;
      summary: string;
    }[];
    expect(events.filter((e) => e.type === "run.resumed").map((e) => e.summary)).toEqual([
      "run resumed: crash",
    ]);
  }, 90_000);
});
