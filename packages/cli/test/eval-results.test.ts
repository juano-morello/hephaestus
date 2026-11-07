import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunMetrics } from "../src/eval/metrics.ts";
import {
  compareLabels,
  type EvalRunResult,
  type EvalStatus,
  readResults,
  renderComparison,
  resultExists,
  summarize,
  writeResult,
} from "../src/eval/results.ts";

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "heph-results-"));
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

const metrics = (m: Partial<RunMetrics> = {}): RunMetrics => ({
  first_pass_valid: true,
  units: 2,
  attempts: 2,
  attempts_per_unit: 1,
  escalations: 0,
  stalls: 0,
  scope_violations: 0,
  tokens: 100,
  wall_ms: 1000,
  ...m,
});
const mk = (
  task: string,
  run: number,
  status: EvalStatus,
  m?: Partial<RunMetrics> | null,
  label = "L",
): EvalRunResult => ({
  schema: 1,
  task,
  run,
  label,
  status,
  solved: status === "solved" || status === "escalated",
  failures: status === "unsolved" ? ["must_pass server: x exited 1"] : [],
  ...(status === "error" ? { error: "boom" } : {}),
  ...(m === null || status === "error" ? {} : { metrics: metrics(m ?? {}) }),
});

describe("result files", () => {
  test("write, exists and read round trip, sorted by task then run", () => {
    const a = mk("b-task", 2, "solved");
    const b = mk("a-task", 1, "unsolved");
    const c = mk("b-task", 1, "error");
    const path = writeResult(out, a);
    expect(path).toBe(join(out, "L", "b-task", "run-2.json"));
    writeResult(out, b);
    writeResult(out, c);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(a);
    expect(resultExists(out, "L", "b-task", 2)).toBe(true);
    expect(resultExists(out, "L", "b-task", 3)).toBe(false);
    expect(resultExists(out, "other", "b-task", 2)).toBe(false);
    expect(readResults(out, "L").map((r) => [r.task, r.run])).toEqual([
      ["a-task", 1],
      ["b-task", 1],
      ["b-task", 2],
    ]);
  });
  test("a missing label reads as empty", () => {
    expect(readResults(out, "nope")).toEqual([]);
    expect(existsSync(join(out, "nope"))).toBe(false);
  });
  test("run-10 sorts after run-2", () => {
    writeResult(out, mk("t", 10, "solved"));
    writeResult(out, mk("t", 2, "solved"));
    expect(readResults(out, "L").map((r) => r.run)).toEqual([2, 10]);
  });
});

describe("summarize", () => {
  const four = [
    mk("t1", 1, "solved", { first_pass_valid: true, attempts_per_unit: 1, tokens: 100 }),
    mk("t2", 1, "solved", { first_pass_valid: false, attempts_per_unit: 2, tokens: 300 }),
    mk("t1", 2, "unsolved", { first_pass_valid: true, attempts_per_unit: 3, tokens: 200 }),
    mk("t2", 2, "solved", { first_pass_valid: true, attempts_per_unit: 2, tokens: 400 }),
    mk("t3", 1, "error"),
  ];

  test("rates, errors excluded and counted, per-task and overall metric stats", () => {
    const s = summarize(four);
    expect(s).toMatchObject({ label: "L", runs: 5, errors: 1 });
    expect(s.overall.n).toBe(4);
    expect(s.overall.solved_rate).toBe(0.75);
    expect(s.overall.first_pass_valid_rate).toBe(0.75);
    expect(s.overall.metrics.tokens).toEqual({ mean: 250, min: 100, max: 400 });
    expect(s.overall.metrics.attempts_per_unit).toEqual({ mean: 2, min: 1, max: 3 });
    expect(s.tasks.t1?.solved_rate).toBe(0.5);
    expect(s.tasks.t2?.solved_rate).toBe(1);
    // One run per index: t1 solved at index 1 and not at 2.
    expect(s.tasks.t1?.solved_spread).toBe(1);
    expect(s.tasks.t2?.solved_spread).toBe(0);
    expect(s.tasks.t1?.metrics.tokens).toEqual({ mean: 150, min: 100, max: 200 });
    // A task whose only run errored has a row, with null rates.
    expect(s.tasks.t3).toMatchObject({ n: 0, solved_rate: null });
  });

  test("solved_spread is the max minus min of the per-run-index solved rate", () => {
    // Index 1: both solved (1.0). Index 2: one of two solved (0.5).
    expect(summarize(four).overall.solved_spread).toBe(0.5);
  });
  test("a single run index has a spread of 0", () => {
    expect(summarize([mk("t1", 1, "solved"), mk("t2", 1, "unsolved")]).overall.solved_spread).toBe(
      0,
    );
  });

  test("escalation accounting", () => {
    const s = summarize([
      mk("e1", 1, "escalated"),
      mk("e2", 1, "missed_escalation"),
      mk("f1", 1, "false_escalation"),
      mk("s1", 1, "solved"),
    ]);
    // Solved counts the honest escalation: escalated + solved.
    expect(s.overall.solved_rate).toBe(0.5);
    // False escalation is over runs of tasks with an oracle (f1, s1).
    expect(s.overall.false_escalation_rate).toBe(0.5);
    expect(s.overall.honest_escalation_rate).toBe(0.5);
  });
  test("rates with a zero denominator are null", () => {
    const s = summarize([mk("t", 1, "solved", { first_pass_valid: null })]);
    expect(s.overall.first_pass_valid_rate).toBeNull();
    expect(s.overall.honest_escalation_rate).toBeNull();
    expect(s.overall.false_escalation_rate).toBe(0);
    const none = summarize([mk("t", 1, "error")]);
    expect(none.overall).toMatchObject({ n: 0, solved_rate: null, false_escalation_rate: null });
  });
  test("an empty result list summarizes to an empty summary", () => {
    expect(summarize([], "X")).toMatchObject({ label: "X", runs: 0, errors: 0, tasks: {} });
  });
});

describe("compareLabels", () => {
  const sum = (label: string, statuses: [string, number, EvalStatus, Partial<RunMetrics>?][]) =>
    summarize(statuses.map(([t, r, s, m]) => mk(t, r, s, m ?? {}, label)));
  // A: index 1 solves both, index 2 solves one of two: rate 0.75, spread 0.5.
  const A = sum("A", [
    ["t1", 1, "solved"],
    ["t2", 1, "solved"],
    ["t1", 2, "solved"],
    ["t2", 2, "unsolved"],
  ]);

  test("rows, deltas and per-task rates", () => {
    const B = sum("B", [
      ["t1", 1, "solved", { tokens: 300 }],
      ["t2", 1, "unsolved", { tokens: 300 }],
    ]);
    const c = compareLabels(A, B);
    const row = (m: string) => c.rows.find((r) => r.metric === m);
    expect(row("solved_rate")).toMatchObject({ a: 0.75, b: 0.5, delta: -0.25, spread_a: 0.5 });
    expect(row("tokens")).toMatchObject({ a: 100, b: 300, delta: 200, spread_a: 0 });
    expect(c.per_task.map((t) => [t.task, t.solved_a, t.solved_b])).toEqual([
      ["t1", 1, 1],
      ["t2", 0.5, 0],
    ]);
    const t2tokens = c.per_task
      .find((t) => t.task === "t2")
      ?.rows.find((r) => r.metric === "tokens");
    expect(t2tokens).toMatchObject({ a: 100, b: 300, delta: 200, spread_a: 0 });
  });

  test("a solved-rate drop within the spread is not a regression, beyond it is", () => {
    const within = sum("B", [
      ["t1", 1, "solved"],
      ["t2", 1, "unsolved"],
    ]); // 0.5 = 0.75 - 0.25, spread 0.5
    expect(compareLabels(A, within).regressed).toBe(false);
    const beyond = sum("B", [
      ["t1", 1, "unsolved"],
      ["t2", 1, "unsolved"],
    ]); // 0 < 0.75 - 0.5
    expect(compareLabels(A, beyond).regressed).toBe(true);
  });

  test("any first-pass validity drop regresses, even with a solved rate that held", () => {
    const a = sum("A", [["t1", 1, "solved", { first_pass_valid: true }]]);
    const b = sum("B", [["t1", 1, "solved", { first_pass_valid: false }]]);
    expect(compareLabels(a, b).regressed).toBe(true);
    expect(compareLabels(b, a).regressed).toBe(false);
  });

  test("a null rate on either side never regresses on its own", () => {
    const a = sum("A", [["t1", 1, "solved", { first_pass_valid: null }]]);
    const b = sum("B", [["t1", 1, "solved", { first_pass_valid: false }]]);
    expect(compareLabels(a, b).regressed).toBe(false);
  });

  test("a task present in only one label shows null on the other side", () => {
    const B = sum("B", [["t9", 1, "solved"]]);
    const t9 = compareLabels(A, B).per_task.find((t) => t.task === "t9");
    expect(t9).toMatchObject({ task: "t9", solved_a: null, solved_b: 1 });
    expect(t9?.rows.find((r) => r.metric === "tokens")).toMatchObject({ a: null, b: 100 });
  });

  test("renderComparison prints a line per row, the per-task rates and the verdict", () => {
    const B = sum("B", [
      ["t1", 1, "unsolved"],
      ["t2", 1, "unsolved"],
    ]);
    const text = renderComparison(compareLabels(A, B));
    expect(text).toContain("solved_rate  0.75  0  -0.75  (spread 0.5)");
    expect(text).toMatch(/t1\s+solved\s+1\s+0/);
    expect(text.trimEnd().endsWith("REGRESSED")).toBe(true);
    const ok = renderComparison(compareLabels(A, A));
    expect(ok.trimEnd().endsWith("no regression")).toBe(true);
  });

  test("a label whose runs all errored regresses against a clean one", () => {
    const ok = sum("A", [["t1", 1, "solved"]]);
    const broken = summarize([mk("t1", 1, "error", null, "B")], "B");
    const c = compareLabels(ok, broken);
    expect(c.regressed).toBe(true);
    expect(c.rows.find((r) => r.metric === "error_rate")).toMatchObject({ a: 0, b: 1 });
  });

  test("more erroring runs than before regresses even when the solved rate holds", () => {
    const a = summarize([mk("t1", 1, "solved"), mk("t1", 2, "solved")], "A");
    const b = summarize([mk("t1", 1, "solved"), mk("t1", 2, "error", null, "B")], "B");
    expect(compareLabels(a, b).regressed).toBe(true);
    expect(compareLabels(a, a).regressed).toBe(false);
  });

  test("rows with no measured spread say so instead of printing 0", () => {
    const c = compareLabels(A, A);
    expect(c.rows.find((r) => r.metric === "first_pass_valid_rate")?.spread_a).toBeNull();
    expect(renderComparison(c)).toContain("first_pass_valid_rate  1  1  0  (spread n/a)");
  });
});
