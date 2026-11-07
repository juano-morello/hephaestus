import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type Brief,
  briefHash,
  type Criterion,
  type Plan,
  type ProjectGate,
  type Task,
} from "@hephaestus/core";
import { type Ledger, type LedgerEvent, openLedger } from "@hephaestus/ledger";
import { runOk, type Sandbox } from "@hephaestus/sandbox";
import { namedCommandGate } from "../src/builtin-gates.ts";
import { configHash, type EngineConfig } from "../src/config.ts";
import { customGatesFor } from "../src/custom-gates.ts";
import { buildRun, createRun, type RunPlanOptions, recordPlan } from "../src/engine.ts";
import type { UnitGateContext } from "../src/gates.ts";
import { localRunner } from "../src/runner.ts";
import type { Worker } from "../src/worker.ts";
import { initRepo, tempDir, writeFiles } from "./helpers.ts";
import { config, threeRepos } from "./workspace.ts";

const dir = tempDir();

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "T2",
  title: "impl",
  kind: "implement",
  project: "server",
  lane: "contained",
  complexity: "standard",
  complexity_reason: "x",
  scope: ["impl.sh"],
  covers: ["AC1"],
  spec: "x",
  ...overrides,
});

const buf: Criterion = { id: "AC1", text: "buf passes", kind: "behavior", check: { gate: "buf" } };
const names = (gates: { name: string }[]) => gates.map((g) => g.name);

describe("customGatesFor", () => {
  const specs = {
    server: {
      buf: { command: "buf lint", always: false },
      nc: { command: "./nc.sh", always: true },
    },
    web: { nc: { command: "./web-nc.sh", always: true } },
  };

  test("a covering implement task gets the criterion's gate, then the always gates", () => {
    expect(names(customGatesFor({ task: task(), criteria: [buf], specs }))).toEqual(["buf", "nc"]);
  });

  test("a task that does not cover the criterion gets only always gates", () => {
    expect(names(customGatesFor({ task: task({ covers: [] }), criteria: [buf], specs }))).toEqual([
      "nc",
    ]);
  });

  test("a test task skips criterion-named gates but still gets always gates", () => {
    expect(names(customGatesFor({ task: task({ kind: "test" }), criteria: [buf], specs }))).toEqual(
      ["nc"],
    );
  });

  test("always gates are per project", () => {
    const web = task({ project: "web", covers: [] });
    expect(names(customGatesFor({ task: web, criteria: [buf], specs }))).toEqual(["nc"]);
    const other = task({ project: "proto", covers: [] });
    expect(customGatesFor({ task: other, criteria: [buf], specs })).toEqual([]);
  });

  test("a name selected both ways appears once, in the criterion-named position", () => {
    const both: Criterion = { ...buf, check: { gate: "nc" } };
    expect(names(customGatesFor({ task: task(), criteria: [both], specs }))).toEqual(["nc"]);
    const two: Criterion[] = [{ ...buf, id: "AC2", check: { gate: "nc" } }, buf];
    const t = task({ covers: ["AC1", "AC2"] });
    expect(names(customGatesFor({ task: t, criteria: two, specs }))).toEqual(["nc", "buf"]);
  });

  test("a selected gate the project does not define is still returned", () => {
    const t = task({ project: "proto" });
    expect(names(customGatesFor({ task: t, criteria: [buf], specs }))).toEqual(["buf"]);
    expect(names(customGatesFor({ task: task(), criteria: [buf], specs: undefined }))).toEqual([
      "buf",
    ]);
  });
});

type Exec = { command: string; timeoutMs: number | undefined };

function scriptedSandbox(
  reply: (command: string, n: number) => { code: number; out?: string; timedOut?: boolean },
) {
  const calls: Exec[] = [];
  const sandbox: Sandbox = {
    kind: "native",
    root: "/nowhere",
    async exec(command, opts) {
      calls.push({ command, timeoutMs: opts?.timeoutMs });
      const r = reply(command, calls.length);
      return { code: r.code, stdout: r.out ?? "", stderr: "", timedOut: r.timedOut ?? false };
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
    async dispose() {},
  };
  return { sandbox, calls };
}

const ctx = (sandbox?: Sandbox): UnitGateContext => ({
  task: task(),
  attempt: 1,
  project: "server",
  projectPath: "server",
  workdir: "/nowhere",
  diff: { files: [], text: "" },
  lockedPaths: [],
  worker: { schema: 1, summary: "", claims: [], touched: [] },
  commands: {},
  timeoutMs: 10_000,
  ...(sandbox ? { sandbox } : {}),
});

describe("namedCommandGate", () => {
  const spec: ProjectGate = { command: "buf lint", always: false };

  test("exit 0 passes", async () => {
    const { sandbox, calls } = scriptedSandbox(() => ({ code: 0 }));
    const g = namedCommandGate("buf", spec, "server");
    expect(g.needsSandbox).toBe(true);
    expect(await g.run(ctx(sandbox))).toMatchObject({
      gate: "buf",
      verdict: "pass",
      reason: "buf passed",
    });
    expect(calls).toEqual([{ command: "buf lint", timeoutMs: 10_000 }]);
  });

  test("a non-zero exit fails with exit N and the tail", async () => {
    const { sandbox } = scriptedSandbox(() => ({ code: 2, out: "line 1\nbad proto\n" }));
    const r = await namedCommandGate("buf", spec, "server").run(ctx(sandbox));
    expect(r).toMatchObject({ gate: "buf", verdict: "fail", reason: "buf failed" });
    expect(r.evidence[0]).toBe("exit 2");
    expect(r.evidence[1]).toContain("bad proto");
  });

  test("the spec's timeout_ms is passed to exec and named when it fires", async () => {
    const { sandbox, calls } = scriptedSandbox(() => ({ code: 137, timedOut: true }));
    const g = namedCommandGate("buf", { ...spec, timeout_ms: 100 }, "server");
    const r = await g.run(ctx(sandbox));
    expect(calls[0]?.timeoutMs).toBe(100);
    expect(r).toMatchObject({ verdict: "fail", reason: "timed out after 100 ms" });
    expect(r.evidence[0]).toBe("exit 137");
  });

  test("no command fails loudly without running anything", async () => {
    const { sandbox, calls } = scriptedSandbox(() => ({ code: 0 }));
    for (const s of [undefined, { always: false }] as (ProjectGate | undefined)[]) {
      const r = await namedCommandGate("buf", s, "server").run(ctx(sandbox));
      expect(r).toEqual({
        gate: "buf",
        verdict: "fail",
        reason: "gate buf has no command in project server",
        evidence: [],
      });
    }
    expect(calls).toEqual([]);
  });

  test("no sandbox is a failure, not a crash", async () => {
    const r = await namedCommandGate("buf", spec, "server").run(ctx());
    expect(r).toMatchObject({ verdict: "fail", reason: "no sandbox configured for gates" });
  });
});

const gatedBrief: Brief = {
  schema: 1,
  goal: "g",
  context: "",
  decisions: [],
  constraints: [],
  acceptance: [buf],
  out_of_scope: [],
  open_questions: [],
  source: "cli",
};

const gatedPlan: Plan = {
  schema: 1,
  brief_hash: briefHash(gatedBrief),
  tasks: [task()],
  risks: [],
};

const worker: Worker = {
  async spawn(input) {
    writeFiles(input.workdir, { "impl.sh": "echo hi\n" });
    return {
      output: { schema: 1, summary: "", claims: [], touched: ["impl.sh"] },
      transcript: "",
      usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      exit: "ok",
    };
  },
};

const events = (ledger: Ledger, type: string) =>
  ledger
    .read({ run_id: "R1", types: [type] })
    .map((s) => s.event as LedgerEvent & { data: Record<string, unknown> });

describe("a run with a custom gate", () => {
  const specs = { server: { buf: { command: "buf lint", always: false } } };

  async function go(customGates: EngineConfig["customGates"], sandbox: Sandbox) {
    const { root, workspace } = await threeRepos(dir());
    const ledger = openLedger(join(dir(), "node"), { nodeId: "devserver" });
    let opened = 0;
    const options: RunPlanOptions = {
      ledger,
      workspace,
      workspaceRoot: root,
      brief: gatedBrief,
      plan: gatedPlan,
      runId: "R1",
      changesetId: "C1",
      worker,
      gates: [],
      config: { ...config, ...(customGates ? { customGates } : {}) },
      worktreesDir: join(dir(), "worktrees"),
      gateSandbox: async () => {
        opened++;
        return sandbox;
      },
      extraGates: (t) =>
        customGatesFor({ task: t, criteria: gatedBrief.acceptance, specs: customGates }),
    };
    createRun(options);
    recordPlan(options, gatedPlan);
    const out = await buildRun(options);
    return { ledger, out, opened: () => opened };
  }

  test("red on attempt 1 with exit evidence, returned, accepted on attempt 2", async () => {
    const { sandbox, calls } = scriptedSandbox((_c, n) =>
      n === 1 ? { code: 1, out: "buf: bad" } : { code: 0 },
    );
    const { ledger, out, opened } = await go(specs, sandbox);
    expect(out.status).toBe("built");
    expect(calls.map((c) => c.command)).toEqual(["buf lint", "buf lint"]);
    expect(opened()).toBe(2); // opened although `gates` is empty: only the custom gate needs it
    const results = events(ledger, "gate.result")
      .map((e) => ({
        attempt: e.attempt,
        ...(e.data as { gate: string; verdict: string; evidence: string[] }),
      }))
      .filter((r) => r.gate === "buf");
    expect(results).toMatchObject([
      { attempt: 1, gate: "buf", verdict: "fail", evidence: ["exit 1", "buf: bad"] },
      { attempt: 2, gate: "buf", verdict: "pass" },
    ]);
    expect(events(ledger, "unit.returned")).toHaveLength(1);
    expect(events(ledger, "unit.accepted")).toHaveLength(1);
    ledger.close();
  });

  test("a selected gate with no command returns the unit with the exact reason", async () => {
    const { sandbox, calls } = scriptedSandbox(() => ({ code: 0 }));
    const { ledger } = await go({ server: { buf: { always: false } } }, sandbox);
    const r = events(ledger, "gate.result").map((e) => e.data as { reason: string });
    expect(r[0]?.reason).toBe("gate buf has no command in project server");
    expect(calls).toEqual([]);
    ledger.close();
  });
});

describe("custom gates and the config hash", () => {
  test("a changed command changes the hash", () => {
    const a: EngineConfig = {
      ...config,
      customGates: { server: { buf: { command: "a", always: false } } },
    };
    const b: EngineConfig = {
      ...config,
      customGates: { server: { buf: { command: "b", always: false } } },
    };
    expect(configHash(a, [])).not.toBe(configHash(b, []));
    expect(configHash(a, [])).toBe(configHash(structuredClone(a), []));
  });
});

describe("the join re-gate", () => {
  test("does not run extra gates", async () => {
    const repoDir = await initRepo(dir(), { "server/README.md": "x\n" });
    const main = (await runOk(["git", "rev-parse", "main"], { cwd: repoDir })).trim();
    const { sandbox, calls } = scriptedSandbox(() => ({ code: 0 }));
    const runner = localRunner({
      worker,
      gates: [],
      extraGates: (t) =>
        customGatesFor({
          task: t,
          criteria: [buf],
          specs: { server: { buf: { command: "buf lint", always: true } } },
        }),
      gateSandbox: async () => sandbox,
      worktreesDir: join(dir(), "wt"),
      tools: [],
    });
    const r = await runner.rejoin({
      runId: "R1",
      task: task(),
      attempt: 1,
      repoDir,
      projectPath: "server",
      project: { name: "server", stack: "go", commands: {} },
      locked: [],
      commit: main,
      tip: main,
      worker: { schema: 1, summary: "", claims: [], touched: [] },
    });
    expect(r.kind).toBe("joined");
    expect(calls).toEqual([]);
  });
});
