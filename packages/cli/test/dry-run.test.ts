import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openLedger } from "@hephaestus/ledger";
import { type Io, run } from "../src/main.ts";
import type { Deps } from "../src/runtime.ts";
import { deps } from "./fixtures/deps.ts";

let root: string;
let ws: string;
let home: string;

const sh = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
};
function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heph-dry-"));
  ws = join(root, "calc");
  home = join(root, "home");
  put(join(ws, "README.md"), "# calc\n");
  sh(["git", "init", "-q", "-b", "main"], ws);
  sh(["git", "-c", "user.name=T", "-c", "user.email=t@x", "add", "-A"], ws);
  sh(["git", "-c", "user.name=T", "-c", "user.email=t@x", "commit", "-qm", "base"], ws);
  put(join(home, "config.yaml"), "node: { id: test-node }\nsandbox: { mode: native }\n");
  put(join(root, "brief.yaml"), BRIEF);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// biome-ignore lint/suspicious/noExplicitAny: envelope data is checked field by field
type Envelope = { command: string; ok: boolean; data?: any; error?: { message: string } };

async function heph(args: string[], d: Deps = deps, json = true) {
  let out = "";
  const io: Io = {
    cwd: ws,
    env: { HEPH_HOME: home },
    stdout: (s) => {
      out += s;
    },
    stderr: () => {},
    deps: d,
  };
  const code = await run(json ? [...args, "--json"] : args, io);
  return { code, out, env: json ? (JSON.parse(out) as Envelope) : undefined };
}

const eventCount = (runId: string) => {
  const ledger = openLedger(home, { nodeId: "test-node" });
  try {
    return ledger.read({ run_id: runId }).length;
  } finally {
    ledger.close();
  }
};

async function planned(id = "R1") {
  await heph(["init"]);
  const r = await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", id]);
  expect(r.env?.ok).toBe(true);
}

describe("heph run --dry-run", () => {
  test("previews the plan without approval, and changes nothing", async () => {
    await planned();
    const before = eventCount("R1");
    const a = await heph(["run", "R1", "--dry-run"]);
    expect(a.code).toBe(0);
    expect(a.env?.command).toBe("run");
    expect(a.env?.data.dry_run).toBe(true);
    expect(a.env?.data.units).toHaveLength(2);
    expect(a.env?.data.waves).toEqual([["T1"], ["T2"]]);
    expect(eventCount("R1")).toBe(before);
    const b = await heph(["run", "R1", "--dry-run"]);
    expect(b.env?.data).toEqual(a.env?.data);
    expect(existsSync(join(home, "locks")) ? readdirSync(join(home, "locks")) : []).toEqual([]);
    expect((await heph(["status", "R1"])).env?.data.run.status).toBe("planned");
  });

  test("the plain-text form names the run, the waves and the units", async () => {
    await planned();
    const r = await heph(["run", "R1", "--dry-run"], deps, false);
    expect(r.code).toBe(0);
    expect(r.out).toContain("dry run of R1: 2 units, up to 3 in parallel");
    expect(r.out).toContain("wave 1:");
    expect(r.out).toContain("wave 2:");
    expect(r.out).toContain("T2 calc implement contained  implementer -> ");
    expect(r.out).toContain("locked by T1");
  });

  test("lists the role files in effect", async () => {
    await planned();
    put(join(home, "roles", "implementer.md"), "Use tabs.");
    const r = await heph(["run", "R1", "--dry-run"]);
    expect(r.env?.data.prompts).toEqual([
      { role: "implementer", path: join(home, "roles", "implementer.md"), layer: "home" },
    ]);
  });

  test("a run with no finished plan is a clear error", async () => {
    await heph(["init"]);
    const failing: Deps = {
      ...deps,
      planner: async () => {
        throw new Error("planner down");
      },
    };
    await heph(["new", "--brief", join(root, "brief.yaml"), "--run-id", "R2"], failing);
    const r = await heph(["run", "R2", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.env?.error?.message).toContain("has no finished plan");
  });

  test("a cancelled run is refused", async () => {
    await planned();
    await heph(["cancel", "R1"]);
    const r = await heph(["run", "R1", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.env?.error?.message).toContain("run R1 is failed");
  });

  test("an unknown run is an error", async () => {
    await heph(["init"]);
    const r = await heph(["run", "nope", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.env?.error?.message).toContain("no run nope");
  });
});
