import { type GateResult, globsOverlap } from "@hephaestus/core";
import type { UnitGate, UnitGateContext } from "./gates.ts";
import { normalizePath, projectRelative } from "./paths.ts";

/** A gate that answers from the diff alone, without running anything. */
export type DiffGate = Omit<UnitGate, "run"> & { run(ctx: UnitGateContext): GateResult };

const TAIL_LINES = 60;
const TAIL_CHARS = 4000;

const result = (
  gate: string,
  ok: boolean,
  reason: string,
  evidence: string[] = [],
): GateResult => ({
  gate,
  verdict: ok ? "pass" : "fail",
  reason,
  evidence: ok ? [] : evidence,
});

/** Changed files: project-relative when inside the project, repo-relative (flagged) otherwise. */
const changed = (ctx: UnitGateContext) =>
  ctx.diff.files.map((f) => {
    const rel = projectRelative(ctx.projectPath, f);
    return rel === undefined ? { path: f, inside: false } : { path: rel, inside: true };
  });

/** Every changed file is inside the project and matches the task's scope (SPEC section 11). */
export const diffScopeGate: DiffGate = {
  name: "diff_scope",
  run(ctx) {
    const evidence = changed(ctx).flatMap(({ path, inside }) => {
      if (!inside) return [`outside project: ${path}`];
      return ctx.task.scope.some((g) => globsOverlap(g, path)) ? [] : [`out of scope: ${path}`];
    });
    return result(
      "diff_scope",
      evidence.length === 0,
      evidence.length ? "changes outside the task scope" : "all changes in scope",
      evidence,
    );
  },
};

/** Test locking (SPEC section 8): files from earlier test units are never modified. */
export const lockedPathsGate: DiffGate = {
  name: "locked_paths",
  run(ctx) {
    const locked = new Set(ctx.lockedPaths.map(normalizePath));
    const evidence = changed(ctx)
      .filter(({ path, inside }) => inside && locked.has(path))
      .map(({ path }) => `modified locked file: ${path}`);
    return result(
      "locked_paths",
      evidence.length === 0,
      evidence.length ? "locked files modified" : "no locked file modified",
      evidence,
    );
  },
};

/** The diff is the truth: `touched` must list exactly the files that changed (SPEC section 8). */
export const touchedVsDiffGate: DiffGate = {
  name: "touched_vs_diff",
  run(ctx) {
    const diff = changed(ctx).map((c) => c.path);
    const touched = ctx.worker.touched.map(normalizePath);
    const evidence = [
      ...diff.filter((f) => !touched.includes(f)).map((f) => `changed but not in touched: ${f}`),
      ...touched.filter((f) => !diff.includes(f)).map((f) => `in touched but unchanged: ${f}`),
    ];
    return result(
      "touched_vs_diff",
      evidence.length === 0,
      evidence.length ? "touched does not match the diff" : "touched matches the diff",
      evidence,
    );
  },
};

/** The last lines of a command's output, as gate evidence. */
export function tail(stdout: string, stderr: string): string {
  const lines = `${stdout}${stderr}`.replace(/\n+$/, "").split("\n");
  return lines.slice(-TAIL_LINES).join("\n").slice(-TAIL_CHARS);
}

type CommandKey = "test" | "typecheck" | "lint";

function commandGate(name: "tests" | "typecheck" | "lint", key: CommandKey): UnitGate {
  return {
    name,
    needsSandbox: true,
    async run(ctx) {
      const isTestUnit = ctx.task.kind === "test";
      // New tests may reference code that doesn't exist yet: compile errors are the expected red.
      if (name !== "tests" && isTestUnit) return result(name, true, "skipped for test units");
      const command = ctx.commands[key];
      if (!command) {
        return name === "tests"
          ? result(name, false, "no test command configured")
          : result(name, true, `skipped: no ${name} command configured`);
      }
      if (!ctx.sandbox) return result(name, false, "no sandbox configured for gates");

      const r = await ctx.sandbox.exec(command, { timeoutMs: ctx.timeoutMs });
      const out = tail(r.stdout, r.stderr);
      const evidence = [`exit ${r.code}`, ...(out ? [out] : [])];
      if (r.timedOut) return result(name, false, `timed out after ${ctx.timeoutMs} ms`, evidence);
      if (name !== "tests")
        return result(
          name,
          r.code === 0,
          r.code === 0 ? `${name} passed` : `${name} failed`,
          evidence,
        );

      // Red before green (SPEC section 8): a test unit must leave the suite failing.
      if (isTestUnit) {
        return r.code !== 0
          ? result(name, true, "tests fail, as a test unit requires (red before green)")
          : result(name, false, "tests must fail after a test unit (red before green)", evidence);
      }
      return result(
        name,
        r.code === 0,
        r.code === 0 ? "tests pass" : "tests must pass here",
        evidence,
      );
    },
  };
}

export const testsGate = commandGate("tests", "test");
export const typecheckGate = commandGate("typecheck", "typecheck");
export const lintGate = commandGate("lint", "lint");

/** The v0 built-ins, cheapest first. Custom gates can be appended. */
export const builtinGates = (): UnitGate[] => [
  diffScopeGate,
  lockedPathsGate,
  touchedVsDiffGate,
  testsGate,
  typecheckGate,
  lintGate,
];
