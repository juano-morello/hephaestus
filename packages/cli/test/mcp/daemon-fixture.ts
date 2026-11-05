// A real daemon for the MCP end-to-end test, set up as test/daemon.test.ts does (copied, not
// shared, so that file keeps its helpers to itself).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { daemonAt } from "../../src/daemon.ts";
import { type Io, run } from "../../src/main.ts";

export const MAIN = join(import.meta.dir, "..", "..", "src", "main.ts");
const DEPS = join(import.meta.dir, "..", "fixtures", "deps.ts");

export const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** `register` gets the process before the start wait, so a daemon that never answers is still killed. */
export async function startDaemon(
  home: string,
  workerMs: number,
  register: (d: ReturnType<typeof Bun.spawn>) => void,
) {
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
  register(d);
  for (let i = 0; i < 100 && !(await daemonAt(home)); i++) await Bun.sleep(100);
  if (!(await daemonAt(home))) throw new Error("the daemon did not start");
  return d;
}

/** Runs a heph CLI command in-process with --json, as the user would. */
export async function heph(ws: string, home: string, args: string[]) {
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

/** The calc brief from daemon.test.ts's brief.yaml, as the object a chat host would send. */
export const BRIEF = {
  schema: 1,
  source: "cli",
  goal: "add.sh prints the sum of two integers",
  context: "",
  decisions: ["Usage is sh add.sh A B"],
  constraints: ["POSIX sh only"],
  acceptance: [{ id: "AC1", text: "sh add.sh 2 3 prints 5", kind: "behavior" }],
  out_of_scope: [],
  open_questions: [],
};

/** A temp root with an initialized calc workspace and a heph home; remove with `cleanup`. */
export async function setup() {
  const root = mkdtempSync(join(tmpdir(), "heph-mcp-e2e-"));
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
  await heph(ws, home, ["init"]);
  put(
    join(ws, ".heph", "config.yaml"),
    "projects:\n  calc:\n    commands: { test: sh test_add.sh }\n",
  );
  return { root, ws, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
