import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventDraft, openLedger } from "@hephaestus/ledger";
import { loadConfig } from "../src/config.ts";
import { Overview, RunCharts } from "../src/output.ts";
import { openRuntime } from "../src/runtime.ts";

let root: string;
let ws: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heph-views-"));
  ws = join(root, "calc");
  home = join(root, "home");
  mkdirSync(ws, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), "node: { id: test-node }\nsandbox: { mode: native }\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const base = (run_id: string) => ({ run_id, changeset_id: run_id, config_hash: "cfg" }) as const;
const created = (run_id: string): EventDraft => ({
  ...base(run_id),
  actor: "engine",
  type: "run.created",
  data: { owner_node: "test-node", brief_hash: "b".repeat(64), eval: false },
});

type Att = {
  unit: string;
  attempt: number;
  outcome: "green" | "red" | "blocked" | "error";
  model: string;
  role?: string;
  tokens: [number, number, number, number];
  ms?: number;
};

/** The started and finished events of one attempt, as the engine writes them. */
function attempt(run: string, a: Att): EventDraft[] {
  const info = {
    role: a.role ?? "implementer",
    tier: "standard",
    model: a.model,
    provider: "claude",
  } as const;
  const at = { ...base(run), project: "calc", unit_id: a.unit, attempt: a.attempt } as const;
  const [input, output, cache_read, cache_write] = a.tokens;
  return [
    { ...at, actor: "worker", type: "unit.attempt.started", data: info },
    {
      ...at,
      actor: "worker",
      type: "unit.attempt.finished",
      data: {
        ...info,
        usage: { input, output, cache_read, cache_write },
        duration_ms: a.ms ?? 1000,
        outcome: a.outcome,
      },
    },
  ];
}

const stalled = (run: string, unit: string): EventDraft => ({
  ...base(run),
  actor: "engine",
  project: "calc",
  unit_id: unit,
  attempt: 2,
  type: "unit.stalled",
  data: { signature: "abc", attempts: [1, 2], failing: [{ gate: "tests", reason: "1 failed" }] },
});
const escalated = (run: string, unit: string): EventDraft => ({
  ...base(run),
  actor: "engine",
  project: "calc",
  unit_id: unit,
  attempt: 1,
  type: "unit.escalated",
  data: { reason: "blocked: the test is wrong" },
});

function seed(drafts: EventDraft[]) {
  const ledger = openLedger(home, { nodeId: "test-node" });
  ledger.appendMany(drafts);
  ledger.close();
}

async function rtOpen() {
  const loaded = await loadConfig({ workspaceDir: ws, home, nodeId: "test-node" });
  return openRuntime({ loaded, workspaceDir: ws, home });
}

const R1: EventDraft[] = [
  created("R1"),
  ...attempt("R1", {
    unit: "T1",
    attempt: 1,
    outcome: "green",
    model: "m-a",
    tokens: [100, 50, 10, 5],
  }),
  ...attempt("R1", {
    unit: "T1",
    attempt: 2,
    outcome: "green",
    model: "m-a",
    role: "tester",
    tokens: [1, 2, 3, 4],
  }),
  ...attempt("R1", {
    unit: "T2",
    attempt: 1,
    outcome: "red",
    model: "m-a",
    tokens: [200, 100, 0, 0],
    ms: 5000,
  }),
  ...attempt("R1", {
    unit: "T2",
    attempt: 2,
    outcome: "green",
    model: "m-b",
    tokens: [300, 150, 0, 0],
  }),
  ...attempt("R1", {
    unit: "T3",
    attempt: 1,
    outcome: "red",
    model: "m-b",
    tokens: [10, 10, 0, 0],
  }),
  ...attempt("R1", {
    unit: "T3",
    attempt: 2,
    outcome: "red",
    model: "m-b",
    tokens: [10, 10, 0, 0],
  }),
  stalled("R1", "T3"),
  ...attempt("R1", {
    unit: "T4",
    attempt: 1,
    outcome: "blocked",
    model: "m-a",
    tokens: [7, 7, 0, 0],
  }),
  escalated("R1", "T4"),
];

describe("runCharts", () => {
  test("lists attempts per unit, sums tokens by model and role, counts escalations and stalls", async () => {
    seed(R1);
    const rt = await rtOpen();
    const c = rt.runCharts("R1");
    expect(c.units.map((u) => u.unit_id)).toEqual(["T1", "T2", "T3", "T4"]);
    expect(c.units[1]?.attempts).toEqual([
      {
        attempt: 1,
        outcome: "red",
        tier: "standard",
        model: "m-a",
        role: "implementer",
        input: 200,
        output: 100,
        duration_ms: 5000,
      },
      {
        attempt: 2,
        outcome: "green",
        tier: "standard",
        model: "m-b",
        role: "implementer",
        input: 300,
        output: 150,
        duration_ms: 1000,
      },
    ]);
    expect(c.units[3]?.attempts[0]?.outcome).toBe("blocked");
    expect(c.tokens).toEqual([
      {
        model: "m-a",
        role: "implementer",
        input: 307,
        output: 157,
        cache_read: 10,
        cache_write: 5,
      },
      { model: "m-a", role: "tester", input: 1, output: 2, cache_read: 3, cache_write: 4 },
      { model: "m-b", role: "implementer", input: 320, output: 170, cache_read: 0, cache_write: 0 },
    ]);
    expect(c.escalations).toBe(1);
    expect(c.stalls).toBe(1);
    expect(RunCharts.parse(c)).toBeDefined();
    rt.close();
  });

  test("a run with no attempts has empty arrays and zero counts", async () => {
    seed([created("R0")]);
    const rt = await rtOpen();
    expect(rt.runCharts("R0")).toEqual({
      schema: 1,
      run_id: "R0",
      units: [],
      tokens: [],
      escalations: 0,
      stalls: 0,
    });
    rt.close();
  });

  test("a unit id like constructor is just a unit", async () => {
    seed([
      created("RC"),
      ...attempt("RC", {
        unit: "constructor",
        attempt: 1,
        outcome: "green",
        model: "m",
        tokens: [1, 1, 0, 0],
      }),
    ]);
    const rt = await rtOpen();
    expect(rt.runCharts("RC").units.map((u) => u.unit_id)).toEqual(["constructor"]);
    rt.close();
  });
});

describe("overview", () => {
  test("sums across runs: statuses, tokens by model, escalations and stalls", async () => {
    seed([
      ...R1,
      created("R2"),
      { ...base("R2"), actor: "engine", type: "run.failed", data: { reason: "x" } },
      created("R3"),
      ...attempt("R3", {
        unit: "T1",
        attempt: 1,
        outcome: "green",
        model: "m-b",
        tokens: [5, 5, 1, 1],
      }),
      escalated("R3", "T1"),
    ]);
    const rt = await rtOpen();
    const o = rt.overview();
    expect(o.runs).toEqual([
      { status: "created", count: 2 },
      { status: "failed", count: 1 },
    ]);
    expect(o.tokens).toEqual([
      { model: "m-a", input: 308, output: 159, cache_read: 13, cache_write: 9 },
      { model: "m-b", input: 325, output: 175, cache_read: 1, cache_write: 1 },
    ]);
    expect(o.escalations).toBe(2);
    expect(o.stalls).toBe(1);
    expect(Overview.parse(o)).toBeDefined();
    rt.close();
  });

  test("an empty ledger has empty arrays and zeros", async () => {
    const rt = await rtOpen();
    expect(rt.overview()).toEqual({ schema: 1, runs: [], tokens: [], escalations: 0, stalls: 0 });
    rt.close();
  });
});
