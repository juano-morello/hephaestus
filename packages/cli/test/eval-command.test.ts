import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EvalRunResult, type EvalStatus, writeResult } from "../src/eval/results.ts";
import { type Io, run } from "../src/main.ts";
import type { Deps } from "../src/runtime.ts";
import { createEvalSuite, PLAN, planner, sandbox, worker } from "./fixtures/eval-suite.ts";

let root: string;
let suiteDir: string;
let realHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heph-evcmd-"));
  ({ suiteDir, realHome } = createEvalSuite(root));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function heph(args: string[], deps?: Deps) {
  let out = "";
  let err = "";
  const io: Io = {
    cwd: root,
    env: { HEPH_HOME: realHome },
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    ...(deps ? { deps } : {}),
  };
  const code = await run(args, io);
  return { out, err, code };
}
const json = async (args: string[], deps?: Deps) => {
  const r = await heph([...args, "--json"], deps);
  return {
    ...r,
    env: JSON.parse(r.out) as { ok: boolean; data: Data; error?: { message: string } },
  };
};
/** What the eval commands' envelopes carry (eval and eval compare). */
type Data = {
  label: string;
  out: string;
  skipped: { id: string; reason: string }[];
  results: EvalRunResult[];
  summary: unknown;
  a: string;
  b: string;
  regressed: boolean;
  rows: unknown[];
};
const scripted = (replies = [PLAN]) => ({
  sandbox,
  planner: planner(replies).fn,
  worker: worker().w,
});

describe("heph eval", () => {
  test("without --suite it fails with the exact message", async () => {
    const r = await json(["eval"], scripted());
    expect(r.code).toBe(1);
    expect(r.env).toMatchObject({ ok: false, error: { message: "--suite <dir> is required" } });
  });

  test("a bad --runs is an error", async () => {
    for (const runs of ["0", "-1", "two", "1.5"]) {
      const r = await json(["eval", "--suite", suiteDir, `--runs=${runs}`], scripted());
      expect(r.env.error?.message).toBe("--runs takes a positive integer");
    }
  });

  test("runs the suite: result files under <suite>/results, a stderr line per run, the envelope", async () => {
    const r = await json(
      ["eval", "--suite", suiteDir, "--task", "solve", "--label", "first"],
      scripted(),
    );
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    expect(r.env.data).toMatchObject({
      label: "first",
      out: join(suiteDir, "results"),
      skipped: [],
    });
    expect(r.env.data.results).toHaveLength(1);
    expect(r.env.data.results[0]).toMatchObject({ task: "solve", run: 1, status: "solved" });
    expect(r.env.data.summary).toMatchObject({ label: "first", runs: 1, errors: 0 });
    expect(existsSync(join(suiteDir, "results", "first", "solve", "run-1.json"))).toBe(true);
    expect(r.err).toBe("solve run 1: solved\n");
  });

  test("the throwaway workspace and ledger live under the home's eval directory", async () => {
    await json(["eval", "--suite", suiteDir, "--task", "solve", "--label", "L"], scripted());
    expect(existsSync(join(realHome, "eval", "L", "solve", "run-1", "ws", "calc"))).toBe(true);
    expect(existsSync(join(realHome, "eval", "L", "solve", "run-1", "home"))).toBe(true);
  });

  test("the default label is eval- and a UTC timestamp", async () => {
    const r = await json(
      ["eval", "--suite", suiteDir, "--task", "should-escalate"],
      scripted([JSON.stringify({ schema: 1, escalate: ["x"] })]),
    );
    expect(r.env.data.label).toMatch(/^eval-\d{8}T\d{6}Z$/);
  });

  test("--out puts the results elsewhere", async () => {
    const out = join(root, "elsewhere");
    const r = await json(
      ["eval", "--suite", suiteDir, "--task", "solve", "--label", "L", "--out", out],
      scripted(),
    );
    expect(r.env.data.out).toBe(out);
    expect(existsSync(join(out, "L", "solve", "run-1.json"))).toBe(true);
    expect(existsSync(join(suiteDir, "results"))).toBe(false);
  });

  test("--tag, --runs 2 and --resume behave as in runEval", async () => {
    const first = planner([PLAN]);
    const deps = { sandbox, planner: first.fn, worker: worker().w };
    const r = await json(
      ["eval", "--suite", suiteDir, "--tag", "fast", "--runs", "2", "--label", "L"],
      deps,
    );
    expect(r.env.data.results.map((x) => `${x.task}#${x.run}`)).toEqual(["solve#1", "solve#2"]);
    expect(first.calls.n).toBe(2);
    const again = planner([PLAN]);
    const resumed = await json(
      ["eval", "--suite", suiteDir, "--tag", "fast", "--runs", "2", "--label", "L", "--resume"],
      { sandbox, planner: again.fn, worker: worker().w },
    );
    expect(again.calls.n).toBe(0);
    expect(resumed.env.data.results).toHaveLength(2);
  });

  test("--task can be repeated; skipped tasks are listed with their reason", async () => {
    const r = await json(
      [
        "eval",
        "--suite",
        suiteDir,
        "--task",
        "todo",
        "--task",
        "nope",
        "--task",
        "solve",
        "--label",
        "L",
      ],
      scripted(),
    );
    expect(r.env.data.skipped).toEqual([
      { id: "todo", reason: "needs_oracle" },
      { id: "nope", reason: "unknown task" },
    ]);
    expect(r.env.data.results.map((x) => x.task)).toEqual(["solve"]);
  });

  test("human output lists skipped tasks, a line per result and the overall rates", async () => {
    const r = await heph(
      ["eval", "--suite", suiteDir, "--task", "solve", "--task", "todo", "--label", "L"],
      scripted(),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("todo: skipped (needs_oracle)");
    expect(r.out).toContain("solve run 1: solved");
    expect(r.out).toContain("solved_rate");
    expect(r.out).toContain("1");
  });
});

const result = (task: string, run: number, status: EvalStatus, label: string): EvalRunResult => ({
  schema: 1,
  task,
  run,
  label,
  status,
  solved: status === "solved",
  failures: [],
  metrics: {
    first_pass_valid: true,
    units: 1,
    attempts: 1,
    attempts_per_unit: 1,
    escalations: 0,
    stalls: 0,
    scope_violations: 0,
    tokens: 10,
    wall_ms: 5,
  },
});
const seed = (label: string, statuses: EvalStatus[]) =>
  statuses.forEach((s, i) => {
    writeResult(join(suiteDir, "results"), result(`t${i}`, 1, s, label));
  });

describe("heph eval compare", () => {
  test("prints the comparison and exits 0", async () => {
    seed("A", ["solved", "solved"]);
    seed("B", ["solved", "solved"]);
    const r = await heph(["eval", "compare", "A", "B", "--suite", suiteDir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("solved_rate");
    expect(r.out).toContain("no regression");
  });

  test("a regression exits 1 only with --fail-on-regression", async () => {
    seed("A", ["solved", "solved"]);
    seed("B", ["unsolved", "unsolved"]);
    const plain = await heph(["eval", "compare", "A", "B", "--suite", suiteDir]);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain("REGRESSED");
    const gated = await heph([
      "eval",
      "compare",
      "A",
      "B",
      "--suite",
      suiteDir,
      "--fail-on-regression",
    ]);
    expect(gated.code).toBe(1);
    expect(gated.out).toContain("REGRESSED");
    const better = await heph([
      "eval",
      "compare",
      "B",
      "A",
      "--suite",
      suiteDir,
      "--fail-on-regression",
    ]);
    expect(better.code).toBe(0);
  });

  test("--json carries the comparison", async () => {
    seed("A", ["solved"]);
    seed("B", ["unsolved"]);
    const r = await json(["eval", "compare", "A", "B", "--suite", suiteDir]);
    expect(r.env.data).toMatchObject({ a: "A", b: "B", regressed: true });
    expect(r.env.data.rows.length).toBeGreaterThan(0);
  });

  test("a missing or empty label is an error naming it and the directory", async () => {
    seed("A", ["solved"]);
    const out = join(suiteDir, "results");
    const r = await json(["eval", "compare", "A", "ghost", "--suite", suiteDir]);
    expect(r.code).toBe(1);
    expect(r.env.error?.message).toBe(`no results for label ghost in ${out}`);
    const first = await json(["eval", "compare", "ghost", "A", "--suite", suiteDir]);
    expect(first.env.error?.message).toBe(`no results for label ghost in ${out}`);
  });

  test("--out replaces --suite, and one of them is required", async () => {
    seed("A", ["solved"]);
    seed("B", ["solved"]);
    const via = await heph(["eval", "compare", "A", "B", "--out", join(suiteDir, "results")]);
    expect(via.code).toBe(0);
    const none = await json(["eval", "compare", "A", "B"]);
    expect(none.env.error?.message).toBe("--suite <dir> or --out <dir> is required");
  });

  test("both labels are required", async () => {
    const r = await json(["eval", "compare", "A", "--suite", suiteDir]);
    expect(r.env.error?.message).toBe("missing label B");
  });
});

describe("usage", () => {
  test("heph help lists eval and eval compare", async () => {
    const { out } = await heph(["help"]);
    expect(out).toContain("eval --suite <dir>");
    expect(out).toContain("eval compare <labelA> <labelB>");
  });
});
