// Eval results on disk (`<out>/<label>/<task>/run-<k>.json`), their summary and comparison.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunMetrics } from "./metrics.ts";

export type EvalStatus =
  | "solved"
  | "unsolved"
  | "escalated"
  | "missed_escalation"
  | "false_escalation"
  | "error";

export type EvalRunResult = {
  schema: 1;
  task: string;
  run: number;
  label: string;
  status: EvalStatus;
  /** True for `solved` and `escalated` only. */
  solved: boolean;
  failures: string[];
  error?: string;
  metrics?: RunMetrics;
};

const resultPath = (out: string, label: string, task: string, run: number) =>
  join(out, label, task, `run-${run}.json`);

export function writeResult(out: string, r: EvalRunResult): string {
  const path = resultPath(out, r.label, r.task, r.run);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(r, null, 2)}\n`);
  return path;
}

export const resultExists = (out: string, label: string, task: string, run: number): boolean =>
  existsSync(resultPath(out, label, task, run));

export function readResults(out: string, label: string): EvalRunResult[] {
  const dir = join(out, label);
  if (!existsSync(dir)) return [];
  const results: EvalRunResult[] = [];
  for (const task of readdirSync(dir, { withFileTypes: true })) {
    if (!task.isDirectory()) continue;
    for (const f of readdirSync(join(dir, task.name))) {
      if (!/^run-\d+\.json$/.test(f)) continue;
      results.push(JSON.parse(readFileSync(join(dir, task.name, f), "utf8")) as EvalRunResult);
    }
  }
  return results.sort((a, b) => a.task.localeCompare(b.task) || a.run - b.run);
}

const METRIC_KEYS = [
  "attempts_per_unit",
  "escalations",
  "stalls",
  "scope_violations",
  "tokens",
  "wall_ms",
] as const;
type Stat = { mean: number; min: number; max: number };
export type Agg = {
  n: number;
  solved_rate: number | null;
  first_pass_valid_rate: number | null;
  false_escalation_rate: number | null;
  honest_escalation_rate: number | null;
  solved_spread: number;
  metrics: Record<(typeof METRIC_KEYS)[number], Stat>;
};
export type Summary = {
  label: string;
  /** Every result, errors included; `n` of an Agg is the runs that did not error. */
  runs: number;
  errors: number;
  overall: Agg;
  tasks: Record<string, Agg>;
};

const ratio = (num: number, den: number) => (den === 0 ? null : num / den);
const spreadOf = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);

function aggregate(results: EvalRunResult[], withSpread: boolean): Agg {
  const ok = results.filter((r) => r.status !== "error");
  const count = (s: EvalStatus) => ok.filter((r) => r.status === s).length;
  const validity = ok.flatMap((r) =>
    r.metrics && r.metrics.first_pass_valid !== null ? [r.metrics.first_pass_valid] : [],
  );
  const withOracle = ok.length - count("escalated") - count("missed_escalation");
  const rateOf = (rs: EvalRunResult[]) =>
    rs.length ? rs.filter((r) => r.solved).length / rs.length : 0;
  let spread = 0;
  if (withSpread) {
    const byIndex = new Map<number, EvalRunResult[]>();
    for (const r of ok) byIndex.set(r.run, [...(byIndex.get(r.run) ?? []), r]);
    spread = byIndex.size > 1 ? spreadOf([...byIndex.values()].map(rateOf)) : 0;
  }
  const measured = ok.flatMap((r) => (r.metrics ? [r.metrics] : []));
  const stat = (key: (typeof METRIC_KEYS)[number]): Stat => {
    const xs = measured.map((m) => m[key]);
    return xs.length
      ? {
          mean: xs.reduce((a, b) => a + b, 0) / xs.length,
          min: Math.min(...xs),
          max: Math.max(...xs),
        }
      : { mean: 0, min: 0, max: 0 };
  };
  return {
    n: ok.length,
    solved_rate: ratio(ok.filter((r) => r.solved).length, ok.length),
    first_pass_valid_rate: ratio(validity.filter(Boolean).length, validity.length),
    false_escalation_rate: ratio(count("false_escalation"), withOracle),
    honest_escalation_rate: ratio(
      count("escalated"),
      count("escalated") + count("missed_escalation"),
    ),
    solved_spread: spread,
    metrics: Object.fromEntries(METRIC_KEYS.map((k) => [k, stat(k)])) as Agg["metrics"],
  };
}

export function summarize(results: EvalRunResult[], label = results[0]?.label ?? ""): Summary {
  const byTask = new Map<string, EvalRunResult[]>();
  for (const r of results) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r]);
  return {
    label,
    runs: results.length,
    errors: results.filter((r) => r.status === "error").length,
    overall: aggregate(results, true),
    tasks: Object.fromEntries([...byTask].map(([t, rs]) => [t, aggregate(rs, false)])),
  };
}

export type Comparison = {
  a: string;
  b: string;
  rows: {
    metric: string;
    a: number | null;
    b: number | null;
    delta: number | null;
    spread_a: number;
  }[];
  per_task: { task: string; solved_a: number | null; solved_b: number | null }[];
  regressed: boolean;
};

export function compareLabels(a: Summary, b: Summary): Comparison {
  const row = (metric: string, x: number | null, y: number | null, spread_a = 0) => ({
    metric,
    a: x,
    b: y,
    delta: x === null || y === null ? null : y - x,
    spread_a,
  });
  const rates = [
    "first_pass_valid_rate",
    "false_escalation_rate",
    "honest_escalation_rate",
  ] as const;
  const rows = [
    row("solved_rate", a.overall.solved_rate, b.overall.solved_rate, a.overall.solved_spread),
    ...rates.map((k) => row(k, a.overall[k], b.overall[k])),
    ...METRIC_KEYS.map((k) =>
      row(
        k,
        a.overall.metrics[k].mean,
        b.overall.metrics[k].mean,
        a.overall.metrics[k].max - a.overall.metrics[k].min,
      ),
    ),
  ];
  const tasks = [...new Set([...Object.keys(a.tasks), ...Object.keys(b.tasks)])].sort();
  const solvedBeyondSpread =
    a.overall.solved_rate !== null &&
    b.overall.solved_rate !== null &&
    b.overall.solved_rate < a.overall.solved_rate - a.overall.solved_spread;
  const validityDropped =
    a.overall.first_pass_valid_rate !== null &&
    b.overall.first_pass_valid_rate !== null &&
    b.overall.first_pass_valid_rate < a.overall.first_pass_valid_rate;
  return {
    a: a.label,
    b: b.label,
    rows,
    per_task: tasks.map((task) => ({
      task,
      solved_a: a.tasks[task]?.solved_rate ?? null,
      solved_b: b.tasks[task]?.solved_rate ?? null,
    })),
    regressed: solvedBeyondSpread || validityDropped,
  };
}

const num = (n: number | null) => (n === null ? "n/a" : String(Math.round(n * 1000) / 1000));

export function renderComparison(c: Comparison): string {
  return `${[
    `${c.a} vs ${c.b}`,
    ...c.rows.map(
      (r) => `${r.metric}  ${num(r.a)}  ${num(r.b)}  ${num(r.delta)}  (spread ${num(r.spread_a)})`,
    ),
    "per task, solved rate:",
    ...c.per_task.map((t) => `${t.task}  solved  ${num(t.solved_a)}  ${num(t.solved_b)}`),
    c.regressed ? "REGRESSED" : "no regression",
  ].join("\n")}\n`;
}
