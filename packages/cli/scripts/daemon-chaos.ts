#!/usr/bin/env bun
// SPEC section 13 testing, with the daemon: start a build on `heph daemon`, SIGKILL the daemon at
// a random moment, start it again, and require the run to end like one never killed. A daemon
// resumes runs left `running` on its own; a run killed before or after its build (planned,
// built) needs `heph run` again, as it would for you, and the report counts those.
//
//   bun packages/cli/scripts/daemon-chaos.ts [--runs 10] [--seed 1]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { openLedger } from "@hephaestus/ledger";
import { daemonAt } from "../src/daemon.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const DEPS = join(import.meta.dir, "..", "test", "fixtures", "deps.ts");
const WORKER_MS = 400;

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const sh = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

async function heph(home: string, ws: string, args: string[]) {
  const p = Bun.spawn(["bun", MAIN, ...args, "--json"], {
    cwd: ws,
    env: { ...process.env, HEPH_HOME: home },
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return JSON.parse(out) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { message: string };
  };
}

function daemon(home: string) {
  return Bun.spawn(["bun", MAIN, "daemon"], {
    env: {
      ...process.env,
      HEPH_HOME: home,
      HEPH_DEPS_MODULE: DEPS,
      HEPH_TEST_WORKER_MS: String(WORKER_MS),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
}
async function up(home: string) {
  for (let i = 0; i < 100; i++) {
    if (await daemonAt(home)) return;
    await Bun.sleep(100);
  }
  throw new Error("daemon did not start");
}

async function scenario() {
  const root = mkdtempSync(join(tmpdir(), "heph-dchaos-"));
  const ws = join(root, "calc");
  const home = join(root, "home");
  put(join(ws, "README.md"), "# calc\n");
  const g = ["git", "-c", "user.name=T", "-c", "user.email=t@x"];
  sh(["git", "init", "-q", "-b", "main"], ws);
  sh([...g, "add", "-A"], ws);
  sh([...g, "commit", "-qm", "base"], ws);
  put(join(home, "config.yaml"), "node: { id: chaos }\nsandbox: { mode: native }\n");
  put(
    join(root, "brief.yaml"),
    "schema: 1\nsource: cli\ngoal: add.sh prints the sum of two integers\ncontext: ''\ndecisions: [Usage is sh add.sh A B]\nconstraints: [POSIX sh only]\nacceptance:\n  - { id: AC1, text: 'sh add.sh 2 3 prints 5', kind: behavior }\nout_of_scope: []\nopen_questions: []\n",
  );
  await heph(home, ws, ["init"]);
  put(
    join(ws, ".heph", "config.yaml"),
    "projects:\n  calc:\n    commands: { test: sh test_add.sh }\n",
  );
  const d = daemon(home);
  await up(home);
  await heph(home, ws, ["new", "--brief", join(root, "brief.yaml"), "--run-id", "R1"]);
  await heph(home, ws, ["approve", "plan", "R1"]);
  return { root, ws, home, d };
}

/** Read straight from the ledger file: fast enough to time the build itself. */
const ledgerStatus = (home: string) => {
  const l = openLedger(home, { nodeId: "chaos" });
  const s = l.run("R1")?.status;
  l.close();
  return s;
};

const statusOf = async (home: string, ws: string) =>
  ((await heph(home, ws, ["status", "R1"])).data?.run as { status: string } | undefined)?.status;

async function waitSettled(home: string, ws: string, ms = 120_000) {
  const end = Date.now() + ms;
  let s = await statusOf(home, ws);
  while (s === "running" && Date.now() < end) {
    await Bun.sleep(300);
    s = await statusOf(home, ws);
  }
  return s;
}

function outcome(ws: string, home: string) {
  const ledger = openLedger(home, { nodeId: "chaos" });
  const events = ledger.read({ run_id: "R1" }).map((s) => s.event);
  const latest = new Map<string, string>();
  for (const e of events)
    if (e.type.startsWith("effect.")) latest.set((e.data as { key: string }).key, e.type);
  const result = {
    status: ledger.run("R1")?.status,
    tree: sh(["git", "ls-tree", "-r", "heph/R1"], ws),
    commits: sh(["git", "rev-list", "--count", "heph/R1"], ws),
    worktrees: sh(["git", "worktree", "list"], ws).split("\n").length,
    accepted: events
      .filter((e) => e.type === "unit.accepted")
      .map((e) => e.unit_id)
      .sort(),
    greens: events
      .filter(
        (e) =>
          e.type === "unit.attempt.finished" && (e.data as { outcome: string }).outcome === "green",
      )
      .map((e) => e.unit_id)
      .sort(),
    pending: [...latest.values()].filter((t) => t === "effect.intended").length,
  };
  const resumed = events.filter((e) => e.type === "run.resumed").length;
  ledger.close();
  return { result, resumed };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { runs: { type: "string", default: "10" }, seed: { type: "string", default: "1" } },
  });
  let seed = Number(values.seed);
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };

  const base = await scenario();
  const t0 = Date.now();
  await (await daemonAt(base.home))?.call("run", ["R1", {}], base.ws);
  while (ledgerStatus(base.home) !== "staged") {
    if (Date.now() - t0 > 120_000) throw new Error("baseline did not stage");
    await Bun.sleep(25);
  }
  const took = Date.now() - t0;
  base.d.kill("SIGKILL");
  const expected = JSON.stringify(outcome(base.ws, base.home).result);
  rmSync(base.root, { recursive: true, force: true });
  console.log(`baseline: staged in ${took} ms (seed ${values.seed})`);

  let same = 0;
  const runs = Number(values.runs);
  for (let i = 1; i <= runs; i++) {
    const s = await scenario();
    const daemonClient = await daemonAt(s.home);
    await daemonClient?.call("run", ["R1", {}], s.ws);
    const at = Math.floor(random() * took);
    await Bun.sleep(at);
    s.d.kill("SIGKILL");
    await s.d.exited;
    const killedAt = ledgerStatus(s.home);

    const again = daemon(s.home);
    await up(s.home);
    let status = await waitSettled(s.home, s.ws);
    let rerun = false;
    if (status !== "staged") {
      // Not left running (killed before the build started, or between build and staging).
      rerun = true;
      await heph(s.home, s.ws, ["run", "R1"]);
      status = await waitSettled(s.home, s.ws);
    }
    again.kill("SIGKILL");
    await again.exited;
    const { result, resumed } = outcome(s.ws, s.home);
    const ok = JSON.stringify(result) === expected;
    if (ok) same++;
    console.log(
      `run ${i}: killed at ${at} ms while ${killedAt}; ${killedAt === "staged" ? "it had finished" : rerun ? "heph run again" : `resumed by the daemon (${resumed} resume)`}; ${ok ? "same outcome" : "DIFFERENT"}`,
    );
    if (!ok)
      console.log(`  expected ${expected}\n  got      ${JSON.stringify(result)}\n  kept ${s.root}`);
    else rmSync(s.root, { recursive: true, force: true });
  }
  console.log(`${same} of ${runs} killed daemons ended like the baseline`);
  if (same !== runs) process.exit(1);
}

await main();
