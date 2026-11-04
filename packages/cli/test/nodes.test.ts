import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PullRequests, Worker } from "@hephaestus/engine";
import { localTransport } from "@hephaestus/node";
import { loadHomeConfig } from "../src/config.ts";
import { type Host, openHost } from "../src/host.ts";
import { type Io, run } from "../src/main.ts";
import { describe as line } from "../src/runtime.ts";
import { deps } from "./fixtures/deps.ts";

let root: string;
let ws: string;
let homeA: string;
let homeB: string;
let denver: Host;

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const sh = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** Set by a test: why denver can't open pull requests. */
let cantLand: string | undefined;

/** Pull requests that open and stay open: enough to stage. */
const prs: PullRequests = {
  async preflight() {
    return cantLand;
  },
  async open({ head }) {
    return { url: `https://github.com/acme/calc/pull/${head.length}` };
  },
  async find() {
    return undefined;
  },
  async edit() {},
  async status() {
    return { state: "open" };
  },
  async readiness() {
    return { ready: false, reason: "not in this test" };
  },
  async merge() {
    throw new Error("not in this test");
  },
};

beforeEach(async () => {
  cantLand = undefined;
  root = mkdtempSync(join(tmpdir(), "heph-nodes-"));
  ws = join(root, "calc");
  homeA = join(root, "mbp");
  homeB = join(root, "denver");
  put(join(ws, "README.md"), "# calc\n");
  const g = ["git", "-c", "user.name=T", "-c", "user.email=t@x"];
  sh(["git", "init", "-q", "-b", "main"], ws);
  sh([...g, "add", "-A"], ws);
  sh([...g, "commit", "-qm", "base"], ws);
  sh(["git", "clone", "-q", "--bare", ws, join(root, "calc.git")], root);
  sh(["git", "remote", "add", "origin", join(root, "calc.git")], ws);
  sh(["git", "fetch", "-q", "origin"], ws);
  put(
    join(homeA, "config.yaml"),
    "node: { id: mbp }\nsandbox: { mode: native }\nnodes:\n  denver: { ssh: denver, preferred: true }\n",
  );
  put(join(homeB, "config.yaml"), "node: { id: denver }\nsandbox: { mode: native }\n");
  put(join(root, "brief.yaml"), BRIEF);
  denver = openHost({
    home: homeB,
    config: await loadHomeConfig(homeB),
    deps: { ...deps, prs },
    daemon: true,
  });
});
afterEach(async () => {
  await denver.close();
  rmSync(root, { recursive: true, force: true });
});

const BRIEF = `schema: 1
source: cli
goal: add.sh prints the sum of two integers
context: ""
decisions: [Usage is sh add.sh A B]
constraints: [POSIX sh only]
acceptance:
  - { id: AC1, text: "sh add.sh 2 3 prints 5", kind: behavior }
out_of_scope: []
open_questions: []
`;

/** heph on mbp; denver answers as its daemon would, over an in-process transport. */
async function heph(args: string[]) {
  let out = "";
  const io: Io = {
    cwd: ws,
    env: { HEPH_HOME: homeA },
    stdout: (s) => {
      out += s;
    },
    stderr: () => {},
    deps: { ...deps, prs },
    connect: (node) => {
      if (node !== "denver") throw new Error(`unknown node ${node}`);
      return localTransport(denver.peerMethods());
    },
  };
  const code = await run([...args, "--json"], io);
  return {
    ...(JSON.parse(out) as {
      ok: boolean;
      data?: Record<string, unknown>;
      error?: { message: string };
    }),
    code,
  };
}

describe("a run on another node", () => {
  test("is created, planned, approved, built and staged there, driven from this node", async () => {
    await heph(["init", "--force"]);
    // Travels to denver's checkout with the workspace description (it isn't committed).
    put(
      join(ws, ".heph", "config.yaml"),
      "projects:\n  calc:\n    commands: { test: sh test_add.sh }\n",
    );
    const created = await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R1"]);
    expect(created.data).toMatchObject({ run_id: "R1", status: "planned", node: "denver" });
    expect(denver.ledger.run("R1")?.owner_node).toBe("denver");

    const status = await heph(["status", "R1"]);
    expect(status.data).toMatchObject({
      run: { run_id: "R1", owner_node: "denver", status: "planned" },
    });
    expect(status.data?.stale).toBeUndefined();

    expect((await heph(["approve", "plan", "R1"])).ok).toBe(true);
    expect(denver.ledger.read({ run_id: "R1", types: ["human.input"] })).toHaveLength(1);

    const built = await heph(["run", "R1"]);
    expect(built.data).toMatchObject({ run_id: "R1", status: "staged" });
    expect((await heph(["status", "R1"])).data).toMatchObject({ run: { status: "staged" } });

    const checkout = join(homeB, "workspaces", sh(["basename", ws], root));
    expect(sh(["git", "show", "heph/R1:add.sh"], checkout)).toBe("echo $(($1 + $2))");
  }, 60_000);

  test("--on local keeps the run here even when a preferred node answers", async () => {
    await heph(["init", "--force"]);
    const created = await heph([
      "new",
      "--brief",
      join(root, "brief.yaml"),
      "--run-id",
      "R2",
      "--on",
      "local",
    ]);
    expect(created.data).toMatchObject({ node: "mbp" });
    expect(denver.ledger.run("R2")).toBeUndefined();
  });

  test("is refused by a node that couldn't land it, before anything is created", async () => {
    await heph(["init", "--force"]);
    cantLand = "gh can't reach the repo: not logged in";
    const created = await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R4"]);
    expect(created.ok).toBe(false);
    expect(created.error?.message).toContain(
      "denver can't take workspace calc:\n  calc: gh can't reach the repo: not logged in",
    );
    expect(created.error?.message).toContain("heph new --on local keeps the run on mbp");
    expect(denver.ledger.run("R4")).toBeUndefined();
  });

  test("status says possibly stale when the owner can't be reached", async () => {
    await heph(["init", "--force"]);
    await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R3"]);
    let out = "";
    const io: Io = {
      cwd: ws,
      env: { HEPH_HOME: homeA },
      stdout: (s) => {
        out += s;
      },
      stderr: () => {},
      deps,
      connect: () => {
        throw new Error("ssh: connect to host denver port 22: Operation timed out");
      },
    };
    await run(["status", "R3", "--json"], io);
    expect(JSON.parse(out).data).toMatchObject({
      run: { owner_node: "denver" },
      stale: "possibly stale: denver is unreachable",
    });
  });
});

describe("the daemon as scheduler", () => {
  test("a rate-limited build goes again on its own after retry_after", async () => {
    await heph(["init", "--force"]);
    put(
      join(ws, ".heph", "config.yaml"),
      "projects:\n  calc:\n    commands: { test: sh test_add.sh }\n",
    );
    // mbp builds as a daemon would; its worker is rate limited once, on T2.
    let limited = false;
    const slept: number[] = [];
    const scripted = deps.worker as Worker;
    const worker: Worker = {
      async spawn(input) {
        if (input.brief.task.id === "T2" && !limited) {
          limited = true;
          return {
            output: undefined,
            transcript: "",
            usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            exit: "rate_limited",
            retry_after: new Date(Date.now() + 60_000).toISOString(),
          };
        }
        return scripted.spawn(input);
      },
    };
    const mbp = openHost({
      home: homeA,
      config: { ...(await loadHomeConfig(homeA)), nodes: {} },
      deps: { ...deps, worker, prs, sleep: async (ms) => void slept.push(ms) },
      daemon: true,
    });
    try {
      await mbp.api.call("newRun", [Bun.YAML.parse(BRIEF), { runId: "R9", on: "local" }], ws);
      await mbp.api.call("approvePlan", ["R9"], ws);
      await mbp.api.call("run", ["R9", {}], ws);
      for (let i = 0; i < 200 && mbp.ledger.run("R9")?.status !== "staged"; i++)
        await Bun.sleep(50);
      expect(mbp.ledger.run("R9")?.status).toBe("staged");
      expect(slept).toHaveLength(1);
      expect(slept[0]).toBeGreaterThan(50_000);
      const resumed = mbp.ledger.read({ run_id: "R9", types: ["run.resumed"] });
      expect(resumed.map((e) => (e.event.data as { reason: string }).reason)).toEqual([
        "rate_limit",
      ]);
    } finally {
      await mbp.close();
    }
  }, 60_000);
});

describe("a run handed off while heph run follows it", () => {
  test("the old node keeps following it at the new owner until it is done there", async () => {
    await heph(["init", "--force"]);
    put(
      join(ws, ".heph", "config.yaml"),
      "projects:\n  calc:\n    commands: { test: sh test_add.sh }\n",
    );
    // mbp's worker holds T2 until the handoff interrupts it; denver's finishes it.
    let reached: () => void = () => {};
    const held = new Promise<void>((r) => {
      reached = r;
    });
    const scripted = deps.worker as Worker;
    const worker: Worker = {
      async spawn(input) {
        if (input.brief.task.id !== "T2") return scripted.spawn(input);
        reached();
        while (!input.signal?.aborted) await Bun.sleep(5);
        return {
          output: undefined,
          transcript: "",
          usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          exit: "interrupted",
        };
      },
    };
    const mbp = openHost({
      home: homeA,
      config: await loadHomeConfig(homeA),
      deps: { ...deps, worker, prs },
      daemon: true,
      connect: () => localTransport(denver.peerMethods()),
    });
    try {
      await mbp.api.call("newRun", [Bun.YAML.parse(BRIEF), { runId: "R5", on: "local" }], ws);
      await mbp.api.call("approvePlan", ["R5"], ws);
      await mbp.api.call("run", ["R5", {}], ws);
      await held;

      // Follow as heph run does, polling throughout the handoff.
      type Step = { events: { id: string; type: string; node_id: string }[]; done: boolean };
      const steps: Step[] = [];
      const following = (async () => {
        let after: string | undefined;
        for (;;) {
          const f = (await mbp.api.call("follow", ["R5", after], ws)) as Step & {
            status: string;
          };
          steps.push(f);
          after = f.events.at(-1)?.id ?? after;
          if (f.done) return f;
          await Bun.sleep(5);
        }
      })();
      await mbp.api.call("handoff", ["R5", "denver"], ws);
      const end = await following;

      expect(end.status).toBe("staged");
      const seen = steps.flatMap((s) => s.events);
      expect(seen.some((e) => e.type === "run.handed_off" && e.node_id === "mbp")).toBe(true);
      expect(seen.some((e) => e.type === "run.resumed" && e.node_id === "denver")).toBe(true);
      expect(seen.some((e) => e.type === "merge.staged" && e.node_id === "denver")).toBe(true);
      expect(line({ type: "run.handed_off", data: { to: "denver" } })).toBe("handed off to denver");
      // Only the last step says done: none while the run was between nodes.
      expect(steps.filter((s) => s.done)).toHaveLength(1);
    } finally {
      await mbp.close();
    }
  }, 60_000);
});
