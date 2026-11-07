import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventDraft, type Ledger, openLedger } from "@hephaestus/ledger";
import { extractMetrics } from "../src/eval/metrics.ts";

let root: string;
let ledger: Ledger;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heph-metrics-"));
  ledger = openLedger(root, { nodeId: "test-node" });
});
afterEach(() => {
  ledger.close();
  rmSync(root, { recursive: true, force: true });
});

const base = (run_id: string) => ({ run_id, changeset_id: run_id, config_hash: "cfg" }) as const;
const created = (run: string): EventDraft => ({
  ...base(run),
  actor: "engine",
  type: "run.created",
  data: { owner_node: "test-node", brief_hash: "b".repeat(64), eval: true },
});
const answer = (run: string, attempt: number, outcome: "valid" | "invalid" | "escalated") =>
  ({
    ...base(run),
    actor: "engine",
    type: "plan.answer",
    graph_node: "plan",
    data: { attempt, outcome, failures: [] },
  }) as EventDraft;
const finished = (run: string, unit: string, attempt: number, input: number, output: number) =>
  ({
    ...base(run),
    actor: "worker",
    project: "calc",
    unit_id: unit,
    attempt,
    type: "unit.attempt.finished",
    data: {
      role: "implementer",
      tier: "standard",
      model: "m",
      provider: "p",
      usage: { input, output, cache_read: 0, cache_write: 0 },
      duration_ms: 5,
      outcome: "green",
    },
  }) as EventDraft;
const stop = (run: string, type: "unit.escalated" | "unit.stalled", unit: string) =>
  ({
    ...base(run),
    actor: "engine",
    project: "calc",
    unit_id: unit,
    attempt: 1,
    type,
    data:
      type === "unit.stalled"
        ? { signature: "s", attempts: [1, 2], failing: [{ gate: "tests", reason: "x" }] }
        : { reason: "blocked" },
  }) as EventDraft;
const gate = (run: string, name: string, verdict: "pass" | "fail") =>
  ({
    ...base(run),
    actor: "gate",
    project: "calc",
    unit_id: "T1",
    attempt: 1,
    type: "gate.result",
    data: { gate: name, verdict, reason: "r", evidence: [] },
  }) as EventDraft;

describe("extractMetrics", () => {
  test("first-pass validity is the first plan.answer's outcome", () => {
    ledger.appendMany([created("A"), answer("A", 1, "valid")]);
    ledger.appendMany([created("B"), answer("B", 1, "invalid"), answer("B", 2, "valid")]);
    ledger.appendMany([created("C"), answer("C", 1, "escalated")]);
    ledger.appendMany([created("N")]);
    expect(extractMetrics(ledger, "A", 1).first_pass_valid).toBe(true);
    expect(extractMetrics(ledger, "B", 1).first_pass_valid).toBe(false);
    expect(extractMetrics(ledger, "C", 1).first_pass_valid).toBe(false);
    expect(extractMetrics(ledger, "N", 1).first_pass_valid).toBeNull();
  });

  test("units, attempts, attempts per unit and tokens", () => {
    ledger.appendMany([
      created("R"),
      answer("R", 1, "valid"),
      finished("R", "T1", 1, 100, 50),
      finished("R", "T1", 2, 10, 5),
      finished("R", "T2", 1, 1, 2),
    ]);
    expect(extractMetrics(ledger, "R", 777)).toMatchObject({
      units: 2,
      attempts: 3,
      attempts_per_unit: 1.5,
      tokens: 168,
      wall_ms: 777,
    });
  });

  test("escalations, stalls and diff_scope failures count; other gates and passes do not", () => {
    ledger.appendMany([
      created("R"),
      stop("R", "unit.escalated", "T1"),
      stop("R", "unit.escalated", "T2"),
      stop("R", "unit.stalled", "T1"),
      gate("R", "diff_scope", "fail"),
      gate("R", "diff_scope", "pass"),
      gate("R", "tests", "fail"),
    ]);
    const m = extractMetrics(ledger, "R", 1);
    expect(m).toMatchObject({ escalations: 2, stalls: 1, scope_violations: 1 });
  });

  test("another run's events are not counted", () => {
    ledger.appendMany([created("A"), created("B"), stop("B", "unit.stalled", "T1")]);
    ledger.appendMany([finished("B", "T1", 1, 9, 9)]);
    expect(extractMetrics(ledger, "A", 1)).toMatchObject({ stalls: 0, attempts: 0, tokens: 0 });
  });

  test("an empty run has zeros", () => {
    ledger.appendMany([created("E")]);
    expect(extractMetrics(ledger, "E", 0)).toEqual({
      first_pass_valid: null,
      units: 0,
      attempts: 0,
      attempts_per_unit: 0,
      escalations: 0,
      stalls: 0,
      scope_violations: 0,
      tokens: 0,
      wall_ms: 0,
    });
  });
});
