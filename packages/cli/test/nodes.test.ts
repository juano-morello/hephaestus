import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PullRequests, Worker } from "@hephaestus/engine";
import { localTransport, type Transport } from "@hephaestus/node";
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
  async setBase() {},
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

  test("a forwarded command brings the sender's heph config to the owner's checkout", async () => {
    await heph(["init", "--force"]);
    put(join(ws, ".heph", "config.yaml"), "projects:\n  calc:\n    commands: { test: sh a.sh }\n");
    await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R6"]);
    const there = join(homeB, "workspaces", "calc", ".heph", "config.yaml");
    expect(readFileSync(there, "utf8")).toContain("sh a.sh");

    put(join(ws, ".heph", "config.yaml"), "projects:\n  calc:\n    commands: { test: sh b.sh }\n");
    expect((await heph(["approve", "plan", "R6"])).ok).toBe(true);
    expect(readFileSync(there, "utf8")).toContain("sh b.sh");
  });

  test("a workspace that can't leave this node stays here when no node was asked for", async () => {
    await heph(["init", "--force"]);
    sh(["git", "remote", "remove", "origin"], ws);
    const created = await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R7"]);
    expect(created.data).toMatchObject({ run_id: "R7", status: "planned", node: "mbp" });
    expect(created.data?.placed).toBe(
      "here: a run on denver needs every repo to have a remote named origin; missing in calc",
    );
    // Asked for by name, it is an error.
    const asked = await heph(["new", "--brief", join(root, "brief.yaml"), "--on", "denver"]);
    expect(asked.ok).toBe(false);
  });

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
  test("a peer that hangs: reads answer stale within the read-sync bound, one sync in flight", async () => {
    await heph(["init", "--force"]);
    await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R5"]);
    let connects = 0;
    const mbp = openHost({
      home: homeA,
      config: await loadHomeConfig(homeA),
      deps,
      readSyncMs: 100,
      connect: () => {
        connects++;
        // Accepts the connection, then never answers (a peer whose ssh has not dropped yet).
        return { request: () => new Promise<never>(() => {}), close: async () => {} };
      },
    });
    try {
      const t0 = Date.now();
      const status = (await mbp.api.call("status", ["R5"], ws)) as Record<string, unknown>;
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(status).toMatchObject({
        run: { owner_node: "denver" },
        stale: "possibly stale: denver is unreachable",
      });
      const t1 = Date.now();
      await mbp.api.call("explain", ["R5"], ws);
      await mbp.api.call("planShow", ["R5"], ws);
      await mbp.api.call("status", ["R5"], ws);
      expect(Date.now() - t1).toBeLessThan(1500);
      // Every read after the first reuses the sync still in flight to denver.
      expect(connects).toBe(1);
    } finally {
      await mbp.close();
    }
  });

  describe("reusing a sync in flight", () => {
    let clock: number;
    let connects: number;
    const hang = (): Transport => ({
      request: () => new Promise<never>(() => {}),
      close: async () => {},
    });
    /** A peer that accepts and waits; `release` makes its sync fail. */
    const gated = () => {
      let release: () => void = () => {};
      const t: Transport = {
        request: () =>
          new Promise<never>((_, reject) => {
            release = () => reject(new Error("gone"));
          }),
        close: async () => {},
      };
      return { t, release: () => release() };
    };
    const open = async (connect: () => Transport) => {
      await heph(["init", "--force"]);
      await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R7"]);
      clock = 1_000_000;
      connects = 0;
      return openHost({
        home: homeA,
        config: await loadHomeConfig(homeA),
        deps,
        readSyncMs: 200,
        now: () => clock,
        connect: () => {
          connects++;
          return connect();
        },
      });
    };
    const read = async (mbp: Host) =>
      (await mbp.api.call("status", ["R7"], ws)) as Record<string, unknown>;

    test("a read within the join window joins the sync in flight", async () => {
      const mbp = await open(hang);
      try {
        expect((await read(mbp)).stale).toBeDefined();
        clock += 900;
        expect((await read(mbp)).stale).toBeDefined();
        expect(connects).toBe(1);
      } finally {
        await mbp.close();
      }
    });

    test("between the join window and the wedged threshold a read answers stale at once and connects to nothing", async () => {
      const mbp = await open(hang);
      try {
        await read(mbp);
        clock += 1500;
        const t0 = Date.now();
        const r = await read(mbp);
        expect(Date.now() - t0).toBeLessThan(100);
        expect(r.stale).toBe("possibly stale: denver is unreachable");
        expect(connects).toBe(1);
      } finally {
        await mbp.close();
      }
    });

    test("a sync still unsettled after the wedged threshold is replaced; its replacement can answer", async () => {
      let n = 0;
      const mbp = await open(() => (++n === 1 ? hang() : localTransport(denver.peerMethods())));
      try {
        await read(mbp);
        clock += 30_000;
        const r = await read(mbp);
        expect(connects).toBe(2);
        expect(r.stale).toBeUndefined();
      } finally {
        await mbp.close();
      }
    });

    test("the wedged sync finishing late does not remove its replacement", async () => {
      const first = gated();
      const second = gated();
      let n = 0;
      const mbp = await open(() => (++n === 1 ? first.t : second.t));
      try {
        await read(mbp);
        clock += 30_000;
        await read(mbp);
        expect(connects).toBe(2);
        first.release();
        await Bun.sleep(20);
        clock += 100;
        await read(mbp);
        // Still joins the second sync: the first one's cleanup left it registered.
        expect(connects).toBe(2);
      } finally {
        await mbp.close();
      }
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

describe("handing a run off with --wait", () => {
  /**
   * Hands R5 off while mbp's T2 attempt is in flight. `hold` decides what that worker does once it
   * starts: "finish" ignores the abort and completes after a short while, "until-aborted" only
   * returns when its signal aborts.
   */
  async function handOffWhileBuilding(
    hold: "finish" | "until-aborted" | "rate-limited",
    wait?: number,
    slept?: number[],
  ) {
    await heph(["init", "--force"]);
    put(
      join(ws, ".heph", "config.yaml"),
      "projects:\n  calc:\n    commands: { test: sh test_add.sh }\n",
    );
    let reached: () => void = () => {};
    const held = new Promise<void>((r) => {
      reached = r;
    });
    const scripted = deps.worker as Worker;
    const worker: Worker = {
      async spawn(input) {
        // denver builds with its own scripted worker; only mbp's first T2 attempt is held.
        if (input.brief.task.id !== "T2") return scripted.spawn(input);
        reached();
        if (hold === "finish") {
          await Bun.sleep(200);
          return scripted.spawn(input);
        }
        if (hold === "rate-limited") {
          await Bun.sleep(100);
          return {
            output: undefined,
            transcript: "",
            usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            exit: "rate_limited",
            // Short, because the new owner really waits it out before it resumes the run.
            retry_after: new Date(Date.now() + 300).toISOString(),
          };
        }
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
      deps: {
        ...deps,
        worker,
        prs,
        ...(slept ? { sleep: async (ms: number) => void slept.push(ms) } : {}),
      },
      daemon: true,
      connect: () => localTransport(denver.peerMethods()),
    });
    try {
      await mbp.api.call("newRun", [Bun.YAML.parse(BRIEF), { runId: "R5", on: "local" }], ws);
      await mbp.api.call("approvePlan", ["R5"], ws);
      await mbp.api.call("run", ["R5", {}], ws);
      await held;
      await mbp.api.call("handoff", ["R5", "denver", wait ? { wait } : {}], ws);
      type Seen = { id: string; type: string; node_id: string; unit_id?: string; data: unknown };
      const seen: Seen[] = [];
      let after: string | undefined;
      for (let i = 0; i < 400; i++) {
        const f = (await mbp.api.call("follow", ["R5", after], ws)) as {
          events: Seen[];
          done: boolean;
        };
        seen.push(...f.events);
        after = f.events.at(-1)?.id ?? after;
        if (f.done) break;
        await Bun.sleep(25);
      }
      return seen;
    } finally {
      await mbp.close();
    }
  }

  test("lets the attempt in flight finish, then hands off", async () => {
    const events = await handOffWhileBuilding("finish", 30);
    const at = (type: string, node: string) =>
      events.findIndex((e) => e.type === type && e.node_id === node && e.unit_id === "T2");
    // The attempt in flight ran to its end on mbp, uninterrupted, and mbp started no second one
    // (whether its gates pass depends on the sandbox the test runs in).
    const mbpStarts = events.filter(
      (e) => e.type === "unit.attempt.started" && e.node_id === "mbp" && e.unit_id === "T2",
    );
    expect(mbpStarts).toHaveLength(1);
    expect(at("unit.attempt.finished", "mbp")).toBeGreaterThan(-1);
    expect(events.filter((e) => e.type === "unit.attempt.interrupted")).toEqual([]);
    // Only after it finished did the run move: handed off by mbp, then resumed by denver.
    const handedOff = events.findIndex((e) => e.type === "run.handed_off" && e.node_id === "mbp");
    expect(handedOff).toBeGreaterThan(at("unit.attempt.finished", "mbp"));
    expect(events.some((e) => e.type === "run.resumed" && e.node_id === "denver")).toBe(true);
  }, 60_000);

  test("a rate limit during the wait does not restart the build on the old node", async () => {
    const slept: number[] = [];
    const events = await handOffWhileBuilding("rate-limited", 30, slept);
    // The drained build ended rate limited; the daemon must not start it again (it would sleep
    // out the retry_after and then build a run that is no longer its own).
    expect(slept).toEqual([]);
    expect(events.some((e) => e.type === "run.handed_off" && e.node_id === "mbp")).toBe(true);
    expect(events.some((e) => e.type === "run.resumed" && e.node_id === "mbp")).toBe(false);
  }, 60_000);

  test("a wait shorter than the attempt interrupts it, and denver redoes it", async () => {
    const events = await handOffWhileBuilding("until-aborted", 1);
    const interrupted = events.filter((e) => e.type === "unit.attempt.interrupted");
    expect(interrupted).toMatchObject([
      { unit_id: "T2", node_id: "mbp", data: { reason: "handoff" } },
    ]);
    // The attempt was thrown away, so denver starts T2 again (whether its gates pass is another test).
    expect(
      events.some(
        (e) => e.type === "unit.attempt.started" && e.unit_id === "T2" && e.node_id === "denver",
      ),
    ).toBe(true);
  }, 60_000);
});

describe("cancelling a run under a daemon", () => {
  test("interrupts the attempt in flight instead of letting it run to its end", async () => {
    await heph(["init", "--force"]);
    put(
      join(ws, ".heph", "config.yaml"),
      "projects:\n  calc:\n    commands: { test: sh test_add.sh }\n",
    );
    let reached: () => void = () => {};
    const held = new Promise<void>((r) => {
      reached = r;
    });
    let sawAbort = false;
    const scripted = deps.worker as Worker;
    const worker: Worker = {
      async spawn(input) {
        if (input.brief.task.id !== "T2") return scripted.spawn(input);
        reached();
        // Holds until told to stop, as OMP does; a cancel that only wrote run.failed would hang here.
        while (!input.signal?.aborted) await Bun.sleep(5);
        sawAbort = true;
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
      await mbp.api.call("newRun", [Bun.YAML.parse(BRIEF), { runId: "R6", on: "local" }], ws);
      await mbp.api.call("approvePlan", ["R6"], ws);
      await mbp.api.call("run", ["R6", {}], ws);
      await held;
      await mbp.api.call("cancel", ["R6"], ws);
      expect(sawAbort).toBe(true);
      const events = mbp.ledger
        .read({ run_id: "R6" })
        .map((s) => s.event as { type: string; unit_id?: string; data: Record<string, unknown> });
      expect(
        events.filter((e) => e.type === "unit.attempt.interrupted" && e.unit_id === "T2"),
      ).toMatchObject([{ data: { reason: "user" } }]);
      expect(events.some((e) => e.type === "unit.attempt.finished" && e.unit_id === "T2")).toBe(
        false,
      );
      expect(events.at(-1)).toMatchObject({
        type: "run.failed",
        data: { reason: "cancelled by user" },
      });
      expect(mbp.ledger.run("R6")?.status).toBe("failed");
    } finally {
      await mbp.close();
    }
  }, 60_000);
});
