import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Brief, GateResult, Plan, Task, Workspace } from "@hephaestus/core";
import { briefHash, RUNGS } from "@hephaestus/core";
import { openLedger } from "@hephaestus/ledger";
import { openSandbox, runOk, type Sandbox } from "@hephaestus/sandbox";
import { builtinGates } from "../src/builtin-gates.ts";
import { DEFAULT_COOLDOWN_MS, type EngineConfig, resolveRoute, rungFor } from "../src/config.ts";
import { attemptBranch, buildRun, type RunPlanOptions, runBranch, runPlan } from "../src/engine.ts";
import type { UnitGate, UnitGateContext } from "../src/gates.ts";
import { createGit, type Git } from "../src/git.ts";
import { routeSignals } from "../src/route.ts";
import type { SpawnInput, SpawnOutput, Worker } from "../src/worker.ts";
import { initRepo, tempDir, writeFiles } from "./helpers.ts";

const dir = tempDir();

const brief: Brief = {
  schema: 1,
  goal: "stacks cap at max_stack",
  context: "",
  decisions: ["max_stack lives in the item table"],
  constraints: ["no locks"],
  acceptance: [
    { id: "AC1", text: "stacks cap at max_stack", kind: "behavior" },
    { id: "AC9", text: "not covered by these tasks", kind: "behavior" },
  ],
  out_of_scope: [],
  open_questions: [],
  source: "cli",
};

const workspace: Workspace = {
  repos: { game: "." },
  projects: { server: { repo: "game", path: "server", stack: "go" } },
};

const task = (id: string, overrides: Partial<Task>): Task => ({
  id,
  title: id,
  kind: "implement",
  project: "server",
  lane: "contained",
  complexity: "standard",
  complexity_reason: "x",
  scope: [],
  covers: ["AC1"],
  spec: `do ${id}`,
  ...overrides,
});

const plan = (tasks?: Task[]): Plan => ({
  schema: 1,
  brief_hash: briefHash(brief),
  // Listed implement-first on purpose: the engine must order by derived edges, not plan order.
  tasks: tasks ?? [
    task("T2", { scope: ["inventory/stack.go"], consumes: ["test:Cap"] }),
    task("T1", { kind: "test", scope: ["inventory/*_test.go"], produces: ["test:Cap"] }),
  ],
  risks: [],
});

const config: EngineConfig = {
  routing: {
    test_author: { default: { model: "claude/sonnet", effort: "medium" } },
    implementer: { standard: { model: "claude/sonnet" }, default: { model: "claude/haiku" } },
  },
  maxAttempts: 3,
  parallel: 1,
  budgetTokens: 20_000,
  tools: ["read", "edit", "bash"],
  commands: { server: { test: "go test ./..." } },
};

const usage = { input: 100, output: 50, cache_read: 0, cache_write: 0 };

type Step = {
  files?: Record<string, string>;
  output?: unknown;
  exit?: SpawnOutput["exit"];
};

/** Plays a scripted step per call for each unit and records what it was given. */
function fakeWorker(script: Record<string, Step[]>) {
  const calls: { input: SpawnInput; present: string[] }[] = [];
  const worker: Worker = {
    async spawn(input) {
      const id = input.brief.task.id;
      const n = calls.filter((c) => c.input.brief.task.id === id).length;
      const step = script[id]?.[n] ?? {};
      calls.push({
        input,
        present: (await runOk(["git", "ls-files"], { cwd: input.workdir }))
          .split("\n")
          .filter(Boolean),
      });
      writeFiles(input.workdir, step.files ?? {});
      const touched = Object.keys(step.files ?? {});
      return {
        output: step.output ?? { schema: 1, summary: `did ${id}`, claims: [], touched },
        transcript: `transcript ${id} #${n + 1}`,
        usage,
        exit: step.exit ?? "ok",
        prompt_hash: "p1",
      };
    },
  };
  return { worker, calls };
}

/** Passes when every listed file in the attempt's worktree contains the text. */
const contains = (name: string, path: string, text: string): UnitGate => ({
  name,
  run: (ctx): GateResult => {
    const full = join(ctx.workdir, path);
    const ok = existsSync(full) && readFileSync(full, "utf8").includes(text);
    return {
      gate: name,
      verdict: ok ? "pass" : "fail",
      reason: ok ? "ok" : `${path} lacks ${text}`,
      evidence: ok ? [] : [`${path}: missing "${text}"`],
    };
  },
});

/** Fails every time, but differently each time (the evidence carries the call number). */
const failsDifferently = (name: string): UnitGate => {
  let n = 0;
  return {
    name,
    run: (): GateResult => ({
      gate: name,
      verdict: "fail",
      reason: "still red",
      evidence: [`call ${++n}`],
    }),
  };
};

const onlyFor = (unit: string, gate: UnitGate): UnitGate => ({
  name: gate.name,
  run: (ctx) =>
    ctx.task.id === unit
      ? gate.run(ctx)
      : { gate: gate.name, verdict: "pass", reason: "n/a", evidence: [] },
});

async function setup() {
  const repoDir = await initRepo(dir(), {
    "server/go.mod": "module game\n",
    "server/inventory/stack.go": "package inventory\n",
  });
  const ledger = openLedger(join(dir(), "node"), { nodeId: "devserver" });
  const worktreesDir = join(dir(), "worktrees");
  const go = (
    worker: Worker,
    gates: UnitGate[] = [],
    p = plan(),
    extra: Partial<RunPlanOptions> = {},
  ) =>
    runPlan({
      ledger,
      workspace,
      workspaceRoot: repoDir,
      brief,
      plan: p,
      runId: "R1",
      changesetId: "C1",
      worker,
      gates,
      config,
      worktreesDir,
      ...extra,
    });
  const types = () => ledger.read().map((s) => s.event.type);
  return { repoDir, ledger, worktreesDir, go, types, git: createGit(repoDir) };
}

/** What the sequential build loop wrote for the chain test, before the scheduler replaced it. */
const attempt = (...after: string[]) => ["context.pack_built", "unit.attempt.started", ...after];
const CHAIN_SEQUENCE: string[] = [
  "run.created",
  "run.plan_ready",
  "effect.intended",
  "effect.done",
  "node.started",
  // T1: green at once.
  ...attempt("gate.result", "unit.attempt.finished"),
  "effect.intended",
  "effect.done",
  "unit.accepted",
  // T2: red, then green.
  ...attempt("gate.result", "unit.attempt.finished", "unit.returned"),
  ...attempt("gate.result", "unit.attempt.finished"),
  "effect.intended",
  "effect.done",
  "unit.accepted",
  // T3: blocked.
  ...attempt("unit.attempt.finished", "unit.escalated"),
  "run.paused",
];

const testFile = { "inventory/stack_test.go": "package inventory // TestCap\n" };
const implFile = (v: string) => ({ "inventory/stack.go": `package inventory // ${v}\n` });

describe("runPlan", () => {
  test("happy path: tests first, implement sees them locked, both land on the run branch", async () => {
    const { go, ledger, git, repoDir, types } = await setup();
    const { worker, calls } = fakeWorker({
      T1: [{ files: testFile }],
      T2: [{ files: implFile("capped") }],
    });
    const result = await go(worker, [
      onlyFor("T2", contains("impl", "inventory/stack.go", "capped")),
    ]);

    expect(result).toMatchObject({ status: "built", runBranch: "heph/R1" });
    expect(calls.map((c) => c.input.brief.task.id)).toEqual(["T1", "T2"]);
    const t2 = calls[1];
    expect(t2?.present).toContain("inventory/stack_test.go");
    expect(t2?.input.brief.locked_paths).toEqual(["inventory/stack_test.go"]);
    expect(t2?.input.brief.criteria).toEqual([
      { id: "AC1", text: "stacks cap at max_stack", kind: "behavior" },
    ]);
    expect(t2?.input.brief.decisions).toEqual(["max_stack lives in the item table"]);
    expect(t2?.input.brief.context.locked).toEqual([
      { path: "inventory/stack_test.go", content: testFile["inventory/stack_test.go"] },
    ]);
    // One small file and one criterion: the router starts T2 at trivial, which has no route of
    // its own here and falls back to `default`.
    expect(t2?.input).toMatchObject({
      role: "implementer",
      model: "claude/haiku",
      tools: config.tools,
    });
    expect(calls[0]?.input).toMatchObject({
      role: "test_author",
      model: "claude/sonnet",
      effort: "medium",
    });
    expect(t2?.input.workdir.endsWith(join("R1", "T2", "a1", "server"))).toBe(true);

    const sha = await git.revParse("heph/R1");
    expect(result.heads).toEqual({ game: sha });
    expect((await git.diff("main", sha)).files).toEqual([
      "server/inventory/stack.go",
      "server/inventory/stack_test.go",
    ]);
    // Commits say what the unit did (its title), and which run, unit and attempt made them.
    expect(
      await runOk(
        ["git", "log", "--format=%s|%(trailers:only,unfold,separator=;)", "main..heph/R1"],
        {
          cwd: repoDir,
        },
      ),
    ).toBe(
      "T2|Heph-Run: R1;Heph-Unit: T2;Heph-Attempt: 1\nT1|Heph-Run: R1;Heph-Unit: T1;Heph-Attempt: 1\n",
    );

    expect(types()).toEqual([
      "run.created",
      "run.plan_ready",
      "effect.intended",
      "effect.done",
      "node.started",
      "context.pack_built",
      "unit.attempt.started",
      "gate.result",
      "unit.attempt.finished",
      "effect.intended",
      "effect.done",
      "unit.accepted",
      "context.pack_built",
      "unit.attempt.started",
      "gate.result",
      "unit.attempt.finished",
      "effect.intended",
      "effect.done",
      "unit.accepted",
      "gate.result",
      "node.finished",
    ]);
    expect(ledger.run("R1")).toMatchObject({
      status: "built",
      brief_hash: briefHash(brief),
      eval: false,
    });
    expect(ledger.units("R1").map((u) => [u.unit_id, u.status, u.attempts])).toEqual([
      ["T1", "accepted", 1],
      ["T2", "accepted", 1],
    ]);
    ledger.close();
  });

  test("red then green: the Return reaches the next attempt as feedback", async () => {
    const { go, ledger } = await setup();
    const { worker, calls } = fakeWorker({
      T1: [{ files: testFile }],
      T2: [{ files: implFile("wip") }, { files: implFile("capped") }],
    });
    const result = await go(worker, [
      onlyFor("T2", contains("impl", "inventory/stack.go", "capped")),
    ]);

    expect(result.status).toBe("built");
    const second = calls.filter((c) => c.input.brief.task.id === "T2")[1];
    expect(second?.input.brief.feedback).toEqual({
      diff_stat: "1 file changed, +1 -1: server/inventory/stack.go (+1 -1)",
      schema: 1,
      unit_id: "T2",
      attempt: 1,
      verdict: "red",
      reasons: [
        {
          gate: "impl",
          reason: "inventory/stack.go lacks capped",
          evidence: ['inventory/stack.go: missing "capped"'],
        },
      ],
      scope: ["inventory/stack.go"],
      instruction: "fix only the listed failures; do not modify locked paths",
    });
    expect(second?.input.brief.context.feedback).toEqual(second?.input.brief.feedback);
    expect(ledger.units("R1").find((u) => u.unit_id === "T2")).toMatchObject({
      status: "accepted",
      attempts: 2,
    });
    expect(ledger.attempts("R1", "T2").map((a) => a.outcome)).toEqual(["red", "green"]);
    ledger.close();
  });

  test("three reds: unit escalated, run paused, later units never start, run branch untouched", async () => {
    const p = plan([
      task("T1", { scope: ["inventory/stack.go"], produces: ["fn:A"] }),
      task("T3", { scope: ["inventory/other.go"], consumes: ["fn:A"] }),
    ]);
    const { go, ledger, git } = await setup();
    const { worker, calls } = fakeWorker({
      T1: [{ files: implFile("a") }, { files: implFile("b") }, { files: implFile("c") }],
    });
    const result = await go(worker, [failsDifferently("impl")], p);

    expect(result).toMatchObject({ status: "paused", reason: "T1: red after 3 attempts" });
    expect(calls.map((c) => c.input.brief.task.id)).toEqual(["T1", "T1", "T1"]);
    expect(await git.revParse("heph/R1")).toBe(await git.revParse("main"));
    expect(ledger.run("R1")?.status).toBe("paused");
    expect(ledger.units("R1").map((u) => [u.unit_id, u.status, u.attempts])).toEqual([
      ["T1", "escalated", 3],
      ["T3", "pending", 0],
    ]);
    const last = ledger.read({ types: ["unit.escalated", "run.paused"] }).map((s) => s.event.data);
    expect(last).toEqual([{ reason: "red after 3 attempts" }, { reason: "user" }]);
    ledger.close();
  });

  test("the same failure twice: unit stalled and run paused after two attempts, not three", async () => {
    const p = plan([
      task("T1", { scope: ["inventory/stack.go"], produces: ["fn:A"] }),
      task("T3", { scope: ["inventory/other.go"], consumes: ["fn:A"] }),
    ]);
    const { go, ledger } = await setup();
    const { worker, calls } = fakeWorker({
      T1: [{ files: implFile("a") }, { files: implFile("b") }, { files: implFile("c") }],
    });
    const result = await go(worker, [contains("impl", "inventory/stack.go", "capped")], p);

    expect(result).toMatchObject({
      status: "paused",
      reason: expect.stringContaining(
        "T1: stalled: impl failed the same way on a1 and a2 (repeated: ",
      ),
    });
    expect(calls.map((c) => c.input.brief.task.id)).toEqual(["T1", "T1"]);
    expect(ledger.run("R1")?.status).toBe("paused");
    expect(ledger.units("R1").map((u) => [u.unit_id, u.status, u.attempts])).toEqual([
      ["T1", "escalated", 2],
      ["T3", "pending", 0],
    ]);
    const last = ledger.read({ types: ["unit.stalled", "run.paused"] }).map((s) => s.event.data);
    expect(last).toEqual([
      {
        signature: expect.any(String),
        attempts: [1, 2],
        failing: [
          {
            gate: "impl",
            reason: "inventory/stack.go lacks capped",
            evidence: expect.any(String),
          },
        ],
      },
      { reason: "user" },
    ]);
    expect(ledger.read({ types: ["unit.escalated"] })).toEqual([]);
    ledger.close();
  });

  test("blocked: honest exit escalates at once, no more attempts", async () => {
    const { go, ledger } = await setup();
    const { worker, calls } = fakeWorker({
      T1: [{ files: testFile }],
      T2: [
        {
          output: {
            schema: 1,
            summary: "",
            claims: [],
            touched: [],
            blocked: { reason: "AC1 test expects 51, spec says 50" },
          },
        },
      ],
    });
    const result = await go(worker);

    expect(result).toMatchObject({
      status: "paused",
      reason: "T2: blocked: AC1 test expects 51, spec says 50",
    });
    expect(calls).toHaveLength(2);
    expect(ledger.attempts("R1", "T2").map((a) => a.outcome)).toEqual(["blocked"]);
    expect(ledger.units("R1").find((u) => u.unit_id === "T2")?.status).toBe("escalated");
    ledger.close();
  });

  test("rate limited: the attempt is interrupted, not counted, and the run pauses", async () => {
    const { go, ledger, types } = await setup();
    const { worker } = fakeWorker({ T1: [{ exit: "rate_limited" }] });
    const result = await go(worker);

    expect(result).toMatchObject({ status: "paused", reason: "T1: rate_limit" });
    expect(types().slice(-3)).toEqual([
      "unit.attempt.started",
      "unit.attempt.interrupted",
      "run.paused",
    ]);
    expect(ledger.run("R1")?.status).toBe("paused");
    expect(ledger.units("R1").find((u) => u.unit_id === "T1")).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    expect(ledger.read({ types: ["run.paused"] })[0]?.event.data).toEqual({ reason: "rate_limit" });
    ledger.close();
  });

  test("a chain at parallel 1 writes the same event sequence as the sequential loop; one run.paused per pause", async () => {
    const p = plan([
      task("T3", { scope: ["inventory/other.go"], consumes: ["fn:A"] }),
      task("T2", { scope: ["inventory/stack.go"], consumes: ["test:Cap"], produces: ["fn:A"] }),
      task("T1", { kind: "test", scope: ["inventory/*_test.go"], produces: ["test:Cap"] }),
    ]);
    const { go, ledger, types } = await setup();
    const blocked = {
      output: {
        schema: 1,
        summary: "",
        claims: [],
        touched: [],
        blocked: { reason: "unclear" },
      },
    };
    const { worker, calls } = fakeWorker({
      T1: [{ files: testFile }],
      T2: [{ files: implFile("a") }, { files: implFile("capped") }],
      T3: [blocked],
    });
    const result = await go(
      worker,
      [onlyFor("T2", contains("impl", "inventory/stack.go", "capped"))],
      p,
    );

    expect(result).toMatchObject({ status: "paused", reason: "T3: blocked: unclear" });
    expect(calls.map((c) => c.input.brief.task.id)).toEqual(["T1", "T2", "T2", "T3"]);
    expect(types()).toEqual(CHAIN_SEQUENCE);
    expect(ledger.read({ types: ["run.paused"] }).map((s) => s.event.data)).toEqual([
      { reason: "user" },
    ]);
    ledger.close();
  });

  test("invalid worker output counts as an errored attempt with a worker_output reason", async () => {
    const { go, ledger } = await setup();
    const { worker, calls } = fakeWorker({
      T1: [{ output: { done: true } }, { files: testFile }],
      T2: [{ files: implFile("capped") }],
    });
    const result = await go(worker);

    expect(result.status).toBe("built");
    expect(ledger.attempts("R1", "T1").map((a) => a.outcome)).toEqual(["error", "green"]);
    const feedback = calls[1]?.input.brief.feedback;
    expect(feedback?.reasons[0]).toMatchObject({
      gate: "worker_output",
      reason: "worker output does not match WorkerResult",
    });
    ledger.close();
  });

  test("the diff is the truth: gates see what was written, not what was claimed", async () => {
    const { go, ledger } = await setup();
    const seen: UnitGateContext[] = [];
    const spy: UnitGate = {
      name: "spy",
      run: (ctx) => {
        seen.push(ctx);
        return { gate: "spy", verdict: "pass", reason: "ok", evidence: [] };
      },
    };
    const { worker } = fakeWorker({
      T1: [
        {
          files: { "inventory/sneaky_test.go": "x" },
          output: { schema: 1, summary: "", claims: [], touched: ["inventory/stack_test.go"] },
        },
      ],
      T2: [{ files: implFile("capped") }],
    });
    await go(worker, [spy]);

    expect(seen[0]?.diff.files).toEqual(["server/inventory/sneaky_test.go"]);
    expect(seen[0]?.worker.touched).toEqual(["inventory/stack_test.go"]);
    expect(seen[1]?.lockedPaths).toEqual(["inventory/sneaky_test.go"]);
    const finished = ledger.read({ types: ["unit.attempt.finished"] })[0]?.event;
    expect(ledger.blobs.getText(finished?.blobs?.diff as string)).toContain("sneaky_test.go");
    expect(ledger.blobs.getText(finished?.blobs?.transcript as string)).toBe("transcript T1 #1");
    ledger.close();
  });

  test("deterministic branches stay, worktrees go", async () => {
    const { go, git, worktreesDir, ledger } = await setup();
    const { worker } = fakeWorker({
      T1: [{ files: testFile }],
      T2: [{ files: implFile("wip") }, { files: implFile("capped") }],
    });
    await go(worker, [onlyFor("T2", contains("impl", "inventory/stack.go", "capped"))]);

    expect(runBranch("R1")).toBe("heph/R1");
    expect(attemptBranch("R1", "T2", 2)).toBe("heph-attempt/R1/T2/a2");
    for (const b of ["heph-attempt/R1/T1/a1", "heph-attempt/R1/T2/a1", "heph-attempt/R1/T2/a2"]) {
      expect(await git.revParse(b)).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(await git.revParse("heph/R1")).toBe(await git.revParse("heph-attempt/R1/T2/a2"));
    const left = existsSync(worktreesDir) ? readdirSync(join(worktreesDir, "R1", "T2")) : [];
    expect(left).toEqual([]);
    ledger.close();
  });

  test("a plan across repos: one run branch per touched repo, each with only its own commits", async () => {
    const root = dir();
    const fixtures: Record<string, Record<string, string>> = {
      proto: { "messages.txt": "base\n" },
      server: { "README.md": "server\n" },
      web: { "index.html": "web\n" },
    };
    for (const [name, files] of Object.entries(fixtures)) {
      mkdirSync(join(root, name));
      await initRepo(join(root, name), files);
    }
    const ws: Workspace = {
      repos: { proto: "./proto", server: "./server", web: "./web" },
      projects: {
        proto: { repo: "proto", path: ".", stack: "schema" },
        server: { repo: "server", path: ".", stack: "sh", depends_on: ["proto"] },
        web: { repo: "web", path: ".", stack: "ts" },
      },
    };
    const p = plan([
      task("S2", { project: "server", scope: ["impl.sh"], consumes: ["test:Loot"] }),
      task("S1", {
        project: "server",
        kind: "test",
        scope: ["check.sh"],
        consumes: ["proto:Loot"],
        produces: ["test:Loot"],
      }),
      task("P1", {
        project: "proto",
        kind: "codegen",
        covers: [],
        scope: ["loot.txt"],
        produces: ["proto:Loot"],
      }),
    ]);
    const ledger = openLedger(join(dir(), "node"), { nodeId: "devserver" });
    const { worker, calls } = fakeWorker({
      P1: [{ files: { "loot.txt": "LootDrop\n" } }],
      S1: [{ files: { "check.sh": "test -f impl.sh\n" } }],
      S2: [{ files: { "impl.sh": "echo loot\n" } }],
    });
    const result = await runPlan({
      ledger,
      workspace: ws,
      workspaceRoot: root,
      brief,
      plan: p,
      runId: "R1",
      changesetId: "C1",
      worker,
      gates: [],
      config,
      worktreesDir: join(dir(), "worktrees"),
    });

    expect(result.status).toBe("built");
    expect(calls.map((c) => c.input.brief.task.id)).toEqual(["P1", "S1", "S2"]);
    const proto = createGit(join(root, "proto"));
    const server = createGit(join(root, "server"));
    expect(result.heads).toEqual({
      proto: await proto.revParse("heph/R1"),
      server: await server.revParse("heph/R1"),
    });
    expect((await proto.diff("main", "heph/R1")).files).toEqual(["loot.txt"]);
    expect((await server.diff("main", "heph/R1")).files).toEqual(["check.sh", "impl.sh"]);
    await expect(createGit(join(root, "web")).revParse("heph/R1")).rejects.toThrow();
    const repos = ledger
      .read({ types: ["unit.attempt.started"] })
      .map((e) => [e.event.unit_id, e.event.repo]);
    expect(repos).toEqual([
      ["P1", "proto"],
      ["S1", "server"],
      ["S2", "server"],
    ]);
    ledger.close();
  });

  test("rejects a task whose project is not in the workspace", async () => {
    const { go, ledger } = await setup();
    await expect(
      go(fakeWorker({}).worker, [], plan([task("X1", { project: "mobile", scope: ["a"] })])),
    ).rejects.toThrow("task X1: unknown project mobile");
    expect(ledger.read()).toEqual([]);
    ledger.close();
  });

  test("rejects a plan for a different brief", async () => {
    const { go, ledger } = await setup();
    await expect(go(fakeWorker({}).worker, [], { ...plan(), brief_hash: "other" })).rejects.toThrow(
      "plan brief_hash does not match the brief",
    );
    ledger.close();
  });
});

describe("rungFor", () => {
  test("each red climbs one rung, capped at top, or at complex without a top route", () => {
    expect(rungFor("trivial", 0, true)).toBe("trivial");
    expect(rungFor("trivial", 2, true)).toBe("complex");
    expect(rungFor("complex", 1, true)).toBe("top");
    expect(rungFor("complex", 1, false)).toBe("complex");
    expect(rungFor("standard", 5, true)).toBe("top");
  });
});

describe("resolveRoute", () => {
  test("top falls back to the complex route when the role has none", () => {
    const c: EngineConfig = {
      ...config,
      routing: { implementer: { complex: { model: "m/c" }, default: { model: "m/d" } } },
    };
    expect(resolveRoute(c, "implementer", "top")).toEqual({ model: "m/c" });
    expect(resolveRoute(c, "implementer", "trivial")).toEqual({ model: "m/d" });
  });

  test("a role with only default resolves for every rung", () => {
    const c: EngineConfig = { ...config, routing: { documenter: { default: { model: "m/d" } } } };
    for (const rung of RUNGS) expect(resolveRoute(c, "documenter", rung)).toEqual({ model: "m/d" });
    expect(() => resolveRoute(c, "implementer", "top")).toThrow("no route for role implementer");
  });
});

describe("the escalation ladder", () => {
  const ladder: EngineConfig = {
    ...config,
    routing: {
      test_author: { default: { model: "claude/sonnet" } },
      implementer: {
        trivial: { model: "m/trivial" },
        standard: { model: "m/standard" },
        complex: { model: "m/complex" },
        top: { model: "m/top" },
      },
    },
  };
  const solo = (complexity: Task["complexity"] = "standard") =>
    plan([task("T1", { scope: ["inventory/stack.go"], complexity })]);
  /** Red (each time differently, so it never stalls) for the first `reds` calls, then green. */
  const redFor = (reds: number): UnitGate => {
    let n = 0;
    return {
      name: "impl",
      run: (): GateResult =>
        ++n <= reds
          ? { gate: "impl", verdict: "fail", reason: "red", evidence: [`call ${n}`] }
          : { gate: "impl", verdict: "pass", reason: "ok", evidence: [] },
    };
  };
  const started = (ledger: ReturnType<typeof openLedger>) =>
    ledger
      .read({ types: ["unit.attempt.started"] })
      .map((s) => s.event.data as { tier: string; model: string; routed?: unknown });
  const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ files: implFile(`v${i}`) }));

  test("red twice then green: the attempts climb one rung each; routed only on the first", async () => {
    for (const complexity of ["trivial", "complex"] as const) {
      const { go, ledger } = await setup();
      const { worker } = fakeWorker({ T1: steps(3) });
      const result = await go(worker, [redFor(2)], solo(complexity), { config: ladder });
      expect(result.status).toBe("built");

      const s = started(ledger);
      const first = s[0]?.routed as { tier: Task["complexity"]; planner_tier: string };
      expect(first).toMatchObject({ planner_tier: complexity, score: expect.any(Number) });
      const at = RUNGS.indexOf(first.tier);
      const rungs = [0, 1, 2].map((i) => RUNGS[Math.min(at + i, 3)] as string);
      expect(s.map((e) => e.tier)).toEqual(rungs);
      expect(s.map((e) => e.model)).toEqual(rungs.map((r) => `m/${r}`));
      expect(s.slice(1).map((e) => e.routed)).toEqual([undefined, undefined]);
      ledger.close();
    }
  });

  test("the router may start below the planner's rating", async () => {
    const { go, ledger } = await setup();
    const { worker } = fakeWorker({ T1: steps(1) });
    await go(worker, [], solo("standard"), { config: ladder });
    expect(started(ledger)[0]).toMatchObject({
      tier: "trivial",
      model: "m/trivial",
      routed: { tier: "trivial", planner_tier: "standard" },
    });
    ledger.close();
  });

  test("an errored attempt does not climb; a red one does", async () => {
    const { go, ledger } = await setup();
    const { worker } = fakeWorker({
      T1: [{ output: { done: true } }, { files: implFile("a") }, { files: implFile("b") }],
    });
    const result = await go(worker, [redFor(1)], solo(), { config: ladder });
    expect(result.status).toBe("built");
    expect(ledger.attempts("R1", "T1").map((a) => a.outcome)).toEqual(["error", "red", "green"]);
    expect(started(ledger).map((e) => e.tier)).toEqual(["trivial", "trivial", "standard"]);
    ledger.close();
  });

  test("a blocked attempt does not change the next attempt's rung", async () => {
    const { go, ledger, repoDir, worktreesDir } = await setup();
    const blocked = {
      output: { schema: 1, summary: "", claims: [], touched: [], blocked: { reason: "unclear" } },
    };
    const first = await go(fakeWorker({ T1: [blocked] }).worker, [], solo(), { config: ladder });
    expect(first).toMatchObject({ status: "paused", reason: "T1: blocked: unclear" });

    const again = await buildRun({
      ledger,
      workspace,
      workspaceRoot: repoDir,
      runId: "R1",
      changesetId: "C1",
      worker: fakeWorker({ T1: steps(1) }).worker,
      gates: [],
      config: ladder,
      worktreesDir,
    });
    expect(again.status).toBe("built");
    const s = started(ledger);
    expect(s.map((e) => e.tier)).toEqual(["trivial", "trivial"]);
    expect(s.map((e) => Boolean(e.routed))).toEqual([true, false]);
    ledger.close();
  });
});

describe("the fallback provider", () => {
  const primary = "claude/sonnet";
  const other = "other/model";
  const routes = (fallback?: string): EngineConfig => ({
    ...config,
    routing: {
      implementer: {
        default: { model: primary },
        ...(fallback ? { fallback: { model: fallback } } : {}),
      },
    },
  });
  /** A chain T1 -> T2 -> ... of implement units, each writing its own file. */
  const chain = (n: number) =>
    plan(
      Array.from({ length: n }, (_, i) =>
        task(`T${i + 1}`, {
          scope: [`inventory/t${i + 1}.go`],
          ...(i > 0 ? { consumes: [`fn:${i}`] } : {}),
          produces: [`fn:${i + 1}`],
        }),
      ),
    );
  type Answer = Partial<Pick<SpawnOutput, "exit" | "retry_after">>;
  /** Answers by unit and model; records "unit model" per call. */
  function byModel(answer: (unit: string, model: string) => Answer | undefined) {
    const calls: string[] = [];
    const worker: Worker = {
      async spawn(input) {
        const id = input.brief.task.id;
        calls.push(`${id} ${input.model}`);
        const a = answer(id, input.model) ?? {};
        const exit = a.exit ?? "ok";
        const file = `inventory/${id.toLowerCase()}.go`;
        if (exit === "ok") writeFiles(input.workdir, { [file]: `package inventory // ${id}\n` });
        return {
          output: { schema: 1, summary: id, claims: [], touched: exit === "ok" ? [file] : [] },
          transcript: `transcript ${id}`,
          usage,
          exit,
          prompt_hash: "p1",
          ...(a.retry_after ? { retry_after: a.retry_after } : {}),
        };
      },
    };
    return { worker, calls };
  }
  const started = (ledger: ReturnType<typeof openLedger>) =>
    ledger.read({ types: ["unit.attempt.started"] }).map(
      (s) =>
        ({ ...(s.event.data as object), unit: s.event.unit_id, attempt: s.event.attempt }) as {
          unit: string;
          attempt: number;
          model: string;
          provider: string;
          fallback_for?: string;
        },
    );
  const limited: Answer = { exit: "rate_limited" };

  test("rate limited on the primary: the next attempt runs on the fallback and the unit finishes", async () => {
    const { go, ledger, types } = await setup();
    const { worker, calls } = byModel((_, m) => (m === primary ? limited : undefined));
    const result = await go(worker, [], chain(1), { config: routes(other), now: () => 0 });

    expect(result.status).toBe("built");
    expect(calls).toEqual([`T1 ${primary}`, `T1 ${other}`]);
    const s = started(ledger);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ attempt: 1, model: primary, provider: "claude" });
    expect(s[0]?.fallback_for).toBeUndefined();
    expect(s[1]).toMatchObject({
      attempt: 2,
      model: other,
      provider: "other",
      fallback_for: "claude",
    });
    const finished = ledger.read({ types: ["unit.attempt.finished"] }).map((e) => e.event.data);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ model: other, fallback_for: "claude", outcome: "green" });
    const interrupted = ledger.read({ types: ["unit.attempt.interrupted"] });
    expect(interrupted.map((e) => [e.event.attempt, e.event.data])).toEqual([
      [1, { reason: "rate_limit" }],
    ]);
    expect(types()).not.toContain("run.paused");
    expect(ledger.units("R1").find((u) => u.unit_id === "T1")?.attempts).toBe(1);
    ledger.close();
  });

  test("a unit starting while the primary cools goes straight to the fallback", async () => {
    const { go, ledger } = await setup();
    const retry_after = new Date(3_600_000).toISOString();
    const { worker, calls } = byModel((_, m) =>
      m === primary ? { exit: "rate_limited", retry_after } : undefined,
    );
    const result = await go(worker, [], chain(2), { config: routes(other), now: () => 0 });

    expect(result.status).toBe("built");
    expect(calls).toEqual([`T1 ${primary}`, `T1 ${other}`, `T2 ${other}`]);
    expect(started(ledger).find((e) => e.unit === "T2")).toMatchObject({
      model: other,
      fallback_for: "claude",
    });
    ledger.close();
  });

  test("past the cooldown a new unit uses the primary again", async () => {
    const { go, ledger } = await setup();
    let clock = 0;
    const retry_after = new Date(10_000).toISOString();
    const { worker, calls } = byModel((u, m) => {
      if (u === "T1" && m === primary) return { exit: "rate_limited", retry_after };
      if (u === "T1") clock = 10_000;
      return undefined;
    });
    const result = await go(worker, [], chain(2), { config: routes(other), now: () => clock });

    expect(result.status).toBe("built");
    expect(calls).toEqual([`T1 ${primary}`, `T1 ${other}`, `T2 ${primary}`]);
    expect(started(ledger).find((e) => e.unit === "T2")?.fallback_for).toBeUndefined();
    ledger.close();
  });

  test("no fallback configured: the run pauses on the rate limit as before", async () => {
    const { go, ledger, types } = await setup();
    const retry_after = new Date(10_000).toISOString();
    const { worker, calls } = byModel(() => ({ exit: "rate_limited", retry_after }));
    const result = await go(worker, [], chain(1), { config: routes(), now: () => 0 });

    expect(result).toMatchObject({ status: "paused", reason: "T1: rate_limit" });
    expect(calls).toEqual([`T1 ${primary}`]);
    expect(types().slice(-3)).toEqual([
      "unit.attempt.started",
      "unit.attempt.interrupted",
      "run.paused",
    ]);
    expect(ledger.read({ types: ["run.paused"] })[0]?.event.data).toEqual({
      reason: "rate_limit",
      retry_after,
    });
    ledger.close();
  });

  test("a fallback on the primary's provider is ignored: the run pauses", async () => {
    const { go, ledger } = await setup();
    const { worker, calls } = byModel((_, m) => (m === primary ? limited : undefined));
    const result = await go(worker, [], chain(1), { config: routes("claude/haiku"), now: () => 0 });

    expect(result).toMatchObject({ status: "paused", reason: "T1: rate_limit" });
    expect(calls).toEqual([`T1 ${primary}`]);
    expect(ledger.read({ types: ["run.paused"] })).toHaveLength(1);
    ledger.close();
  });

  test("a fallback whose provider is cooling too is not used: the run pauses", async () => {
    const { go, ledger, types } = await setup();
    const { worker, calls } = byModel(() => limited);
    const result = await go(worker, [], chain(2), { config: routes(other), now: () => 0 });

    expect(result).toMatchObject({ status: "paused", reason: "T1: rate_limit" });
    // The 429 on the fallback cools its provider as well: no third attempt, T2 never starts.
    expect(calls).toEqual([`T1 ${primary}`, `T1 ${other}`]);
    expect(types().slice(-2)).toEqual(["unit.attempt.interrupted", "run.paused"]);
    expect(ledger.read({ types: ["unit.attempt.interrupted"] })).toHaveLength(2);
    expect(ledger.units("R1").find((u) => u.unit_id === "T1")).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    ledger.close();
  });

  test("providers never take turns: a provider that rate limited in this unit is not retried", async () => {
    const { go, ledger, types } = await setup();
    let clock = 0;
    const { worker, calls } = byModel((_, m) => {
      // The fallback's attempt outlives the primary's cooldown before its own 429.
      if (m === other) clock = 61_000;
      return limited;
    });
    const result = await go(worker, [], chain(1), { config: routes(other), now: () => clock });

    expect(result).toMatchObject({ status: "paused", reason: "T1: rate_limit" });
    expect(calls).toEqual([`T1 ${primary}`, `T1 ${other}`]);
    expect(ledger.read({ types: ["unit.attempt.started"] })).toHaveLength(2);
    expect(ledger.read({ types: ["unit.attempt.interrupted"] })).toHaveLength(2);
    expect(types().slice(-2)).toEqual(["unit.attempt.interrupted", "run.paused"]);
    ledger.close();
  });

  test("with maxAttempts 1 the rate-limited attempt does not use the budget", async () => {
    const { go, ledger } = await setup();
    const { worker, calls } = byModel((_, m) => (m === primary ? limited : undefined));
    const result = await go(worker, [], chain(1), {
      config: { ...routes(other), maxAttempts: 1 },
      now: () => 0,
    });

    expect(result.status).toBe("built");
    expect(calls).toEqual([`T1 ${primary}`, `T1 ${other}`]);
    ledger.close();
  });

  test("without retry_after the cooldown lasts DEFAULT_COOLDOWN_MS", async () => {
    expect(DEFAULT_COOLDOWN_MS).toBe(60_000);
    const { go, ledger } = await setup();
    let clock = 0;
    const { worker, calls } = byModel((u, m) => {
      if (u === "T1" && m === primary) return limited;
      if (u === "T1") clock = 59_999;
      if (u === "T2") clock = 60_000;
      return undefined;
    });
    const result = await go(worker, [], chain(3), { config: routes(other), now: () => clock });

    expect(result.status).toBe("built");
    expect(calls).toEqual([`T1 ${primary}`, `T1 ${other}`, `T2 ${other}`, `T3 ${primary}`]);
    ledger.close();
  });
});

describe("routeSignals", () => {
  test("a submodule (gitlink) in scope is measured as 0 lines instead of failing the route", async () => {
    const repoDir = await initRepo(dir(), { "server/vendor/a.txt": "1\n2\n" });
    const sha = (await runOk(["git", "rev-parse", "HEAD"], { cwd: repoDir })).trim();
    await runOk(
      ["git", "update-index", "--add", "--cacheinfo", `160000,${sha},server/vendor/sub`],
      { cwd: repoDir },
    );
    await runOk(["git", "commit", "-q", "-m", "submodule"], { cwd: repoDir });
    const t = task("T1", { scope: ["vendor/**"] });
    for (const scope of [["vendor/**"], ["**"]]) {
      const signals = await routeSignals({
        git: createGit(repoDir),
        ref: "main",
        projectPath: "server",
        task: { ...t, scope },
        plan: plan([t]),
      });
      expect(signals).toMatchObject({ files: 2, lines: 2 });
    }
  });

  test("a file whose lines cannot be read counts as 0 lines", async () => {
    const repoDir = await initRepo(dir(), { "server/a.go": "1\n2\n3\n", "server/b.go": "1\n" });
    const real = createGit(repoDir);
    const git: Git = {
      ...real,
      fileLines: (ref, path) =>
        path.endsWith("a.go") ? Promise.reject(new Error("boom")) : real.fileLines(ref, path),
    };
    const t = task("T1", { scope: ["*.go"] });
    const signals = await routeSignals({
      git,
      ref: "main",
      projectPath: "server",
      task: t,
      plan: plan([t]),
    });
    expect(signals).toMatchObject({ files: 2, lines: 1 });
  });

  test("more than 20 matched files: no line counts read, lines = files * 100", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`server/gen/f${i}.txt`, "x\n"]),
    );
    const repoDir = await initRepo(dir(), { ...files, "server/other.go": "package x\n" });
    const real = createGit(repoDir);
    let reads = 0;
    const git: Git = {
      ...real,
      fileLines: (ref, path) => {
        reads++;
        return real.fileLines(ref, path);
      },
    };
    const t = task("T1", { scope: ["gen/*.txt"] });
    const signals = await routeSignals({
      git,
      ref: "main",
      projectPath: "server",
      task: t,
      plan: plan([t]),
    });
    expect(reads).toBeLessThanOrEqual(20);
    expect(signals).toEqual({
      files: 25,
      lines: 2500,
      criteria: 1,
      crossProject: false,
      planner: "standard",
    });
  });

  test("up to 20 matched files: lines are counted; a foreign producer is cross-project", async () => {
    const repoDir = await initRepo(dir(), {
      "server/a.go": "1\n2\n3\n",
      "server/b.go": "1\n",
      "server/c.txt": "1\n2\n",
      "proto/p.txt": "p\n",
    });
    // Only the plan says which project produces what: P0's project needs no workspace entry.
    const p0 = task("P0", { project: "proto", scope: ["p.txt"], produces: ["proto:X"] });
    const t = task("T1", { scope: ["*.go"], consumes: ["proto:X"], complexity: "complex" });
    const signals = await routeSignals({
      git: createGit(repoDir),
      ref: "main",
      projectPath: "server",
      task: t,
      plan: plan([p0, t]),
    });
    expect(signals).toEqual({
      files: 2,
      lines: 4,
      criteria: 1,
      crossProject: true,
      planner: "complex",
    });
  });
});

describe("runPlan with the built-in gates", () => {
  // A shell project: check.sh is the test, impl.sh the implementation.
  const shellPlan = () =>
    plan([
      task("T2", { scope: ["impl.sh"], consumes: ["test:Five"] }),
      task("T1", { kind: "test", scope: ["check.sh"], produces: ["test:Five"] }),
    ]);
  const check = { "check.sh": '[ "$(sh impl.sh 2>/dev/null)" = "5" ]\n' };
  const impl = { "impl.sh": "echo 5\n" };
  const withTouched = (files: Record<string, string>, touched = Object.keys(files)) => ({
    files,
    output: { schema: 1, summary: "", claims: [], touched },
  });

  function sandboxes() {
    const log = { opened: 0, disposed: 0 };
    const gateSandbox = async (workdir: string): Promise<Sandbox> => {
      const sb = await openSandbox({ mode: "native", hostDir: workdir });
      log.opened++;
      return { ...sb, dispose: async () => void log.disposed++ };
    };
    return { gateSandbox, log };
  }
  const shellConfig = { ...config, commands: { server: { test: "sh check.sh" } } };

  test("a test unit is accepted while red, the implement unit once green", async () => {
    const { go, ledger } = await setup();
    const { gateSandbox, log } = sandboxes();
    const { worker } = fakeWorker({ T1: [withTouched(check)], T2: [withTouched(impl)] });
    const result = await go(worker, builtinGates(), shellPlan(), {
      gateSandbox,
      config: shellConfig,
    });

    expect(result.status).toBe("built");
    const reasons = ledger
      .read({ types: ["gate.result"] })
      .filter((s) => s.event.unit_id)
      .map(
        (s) =>
          `${s.event.unit_id} ${(s.event.data as { gate: string }).gate}: ${(s.event.data as { reason: string }).reason}`,
      );
    expect(reasons).toEqual([
      "T1 diff_scope: all changes in scope",
      "T1 locked_paths: no locked file modified",
      "T1 touched_vs_diff: touched matches the diff",
      "T1 tests: tests fail, as a test unit requires (red before green)",
      "T1 typecheck: skipped for test units",
      "T1 lint: skipped for test units",
      "T2 diff_scope: all changes in scope",
      "T2 locked_paths: no locked file modified",
      "T2 touched_vs_diff: touched matches the diff",
      "T2 tests: tests pass",
      "T2 typecheck: skipped: no typecheck command configured",
      "T2 lint: skipped: no lint command configured",
    ]);
    expect(log).toEqual({ opened: 2, disposed: 2 });
    ledger.close();
  });

  test("a test unit whose tests already pass is returned and then escalated", async () => {
    const { go, ledger } = await setup();
    const { gateSandbox } = sandboxes();
    const passing = withTouched({ "check.sh": "exit 0\n" });
    const { worker, calls } = fakeWorker({ T1: [passing, passing, passing] });
    const result = await go(worker, builtinGates(), shellPlan(), {
      gateSandbox,
      config: shellConfig,
    });

    expect(result).toMatchObject({
      status: "paused",
      reason: "T1: stalled: tests failed the same way on a1 and a2 (repeated: exit 0)",
    });
    expect(calls[1]?.input.brief.feedback?.reasons).toEqual([
      {
        gate: "tests",
        reason: "tests must fail after a test unit (red before green)",
        evidence: ["exit 0"],
      },
    ]);
    ledger.close();
  });

  test("out-of-scope and unreported changes come back as feedback", async () => {
    const { go, ledger } = await setup();
    const { gateSandbox } = sandboxes();
    const { worker, calls } = fakeWorker({
      T1: [withTouched(check)],
      T2: [withTouched({ ...impl, "extra.sh": "x" }, ["impl.sh"]), withTouched(impl)],
    });
    const result = await go(worker, builtinGates(), shellPlan(), {
      gateSandbox,
      config: shellConfig,
    });

    expect(result.status).toBe("built");
    const feedback = calls.filter((c) => c.input.brief.task.id === "T2")[1]?.input.brief.feedback;
    expect(feedback?.reasons).toEqual([
      {
        gate: "diff_scope",
        reason: "changes outside the task scope",
        evidence: [
          'out of scope: extra.sh (task scope: impl.sh; add "extra.sh" or "*" to the task scope to allow it)',
        ],
      },
      {
        gate: "touched_vs_diff",
        reason: "touched does not match the diff",
        evidence: ["changed but not in touched: extra.sh"],
      },
    ]);
    ledger.close();
  });

  test("modifying a locked test is caught", async () => {
    const { go, ledger } = await setup();
    const { gateSandbox } = sandboxes();
    const { worker, calls } = fakeWorker({
      T1: [withTouched(check)],
      T2: [
        withTouched({ ...impl, "check.sh": "exit 0\n" }, ["impl.sh", "check.sh"]),
        withTouched(impl),
      ],
    });
    await go(worker, builtinGates(), shellPlan(), { gateSandbox, config: shellConfig });

    const feedback = calls.filter((c) => c.input.brief.task.id === "T2")[1]?.input.brief.feedback;
    expect(feedback?.reasons.map((r) => [r.gate, r.evidence])).toEqual([
      ["locked_paths", ["modified locked file: check.sh"]],
    ]);
    ledger.close();
  });

  test("command gates fail clearly when no gate sandbox is configured", async () => {
    const { go, ledger } = await setup();
    const { worker } = fakeWorker({ T1: [withTouched(check)] });
    await go(worker, builtinGates(), shellPlan(), { config: shellConfig });
    const tests = ledger
      .read({ types: ["gate.result"] })
      .find((s) => (s.event.data as { gate: string }).gate === "tests");
    expect(tests?.event.data).toMatchObject({
      verdict: "fail",
      reason: "no sandbox configured for gates",
    });
    ledger.close();
  });
});
