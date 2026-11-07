// The eval runner (SPEC section 14): one golden task, one throwaway workspace and ledger per run,
// then the hidden oracle on what the run built. Nothing here pushes, opens a pull request or
// writes to the real repo or the real ledger: the clones have no remote, and the runtime's home
// is a directory under the eval home.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedConfig, Suite, SuiteTask } from "@hephaestus/core";
import { runBranch } from "@hephaestus/engine";
import { openSandbox, type Sandbox } from "@hephaestus/sandbox";
import { loadConfig } from "../config.ts";
import { type Deps, openRuntime, type Runtime } from "../runtime.ts";
import { extractMetrics } from "./metrics.ts";
import { checkOracle } from "./oracle.ts";
import {
  type EvalRunResult,
  type EvalStatus,
  readResults,
  resultExists,
  type Summary,
  summarize,
  writeResult,
} from "./results.ts";
import { cloneLocal, git, prepareEvalWorkspace } from "./workspace.ts";

/** Opens the sandbox the oracle's commands run in: by default the node's own kind of sandbox. */
export type OracleSandbox = (
  config: ResolvedConfig,
  hostDir: string,
  project: string,
) => Promise<Sandbox>;

const defaultSandbox: OracleSandbox = (config, hostDir, project) =>
  openSandbox(
    config.sandbox.mode === "native"
      ? { mode: "native", hostDir }
      : {
          mode: "container",
          hostDir,
          image: config.projects[project]?.image ?? config.sandbox.image,
          runtime: config.sandbox.runtime,
        },
  );

/** A label or task id becomes a directory name: nothing that leaves its parent. */
const segment = (what: string, s: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) || s.includes(".."))
    throw new Error(`${what} "${s}" must be letters, digits, '.', '_' or '-'`);
  return s;
};

export async function runEvalTask(o: {
  suite: Suite;
  entry: SuiteTask;
  run: number;
  label: string;
  evalHome: string;
  realHome: string;
  deps?: Deps;
  sandboxOf?: OracleSandbox;
  now?: () => number;
}): Promise<EvalRunResult> {
  const { task, brief } = o.entry;
  if (!task || !brief) throw new Error(`eval task ${o.entry.check.id} is not ready to run`);
  const now = o.now ?? Date.now;
  const dir = join(
    o.evalHome,
    segment("label", o.label),
    segment("task id", task.id),
    `run-${o.run}`,
  );
  const result = (status: EvalStatus, extra: Partial<EvalRunResult> = {}): EvalRunResult => ({
    schema: 1,
    task: task.id,
    run: o.run,
    label: o.label,
    status,
    solved: status === "solved" || status === "escalated",
    failures: [],
    ...extra,
  });

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let rt: Runtime | undefined;
  try {
    const started = now();
    const ws = await prepareEvalWorkspace({
      suiteDir: o.suite.dir,
      workspace: o.suite.workspace,
      task,
      dir: join(dir, "ws"),
    });
    // The user's own node config (models, routing), a throwaway ledger.
    const loaded = await loadConfig({ workspaceDir: ws.workspaceDir, home: o.realHome });
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    rt = openRuntime({
      loaded,
      workspaceDir: ws.workspaceDir,
      home,
      ...(o.deps ? { deps: o.deps } : {}),
    });
    const runtime = rt;
    const planned = await runtime.newRun(brief, { eval: true });
    const runId = planned.run_id;
    const done = (status: EvalStatus, failures: string[] = []) =>
      result(status, { failures, metrics: extractMetrics(runtime.ledger, runId, now() - started) });

    if (planned.status === "escalated") return done(task.expect ? "escalated" : "false_escalation");
    if (planned.status === "failed") return done("unsolved", [planned.reason ?? "planning failed"]);
    if (task.expect) return done("missed_escalation");

    runtime.approvePlan(runId);
    const built = await runtime.build(runId, { now: true });
    if (built.status !== "staged")
      return done("unsolved", [
        `build ${built.status}${"reason" in built && built.reason ? `: ${built.reason}` : ""}`,
      ]);

    const oracle = task.oracle;
    if (!oracle) throw new Error(`eval task ${task.id} has neither an oracle nor expect: escalate`);
    // The oracle works on a fresh clone of what the run built, so its test files and build
    // output never touch the run's own worktrees.
    const checkouts: Record<string, string> = {};
    for (const repo of Object.keys(ws.repoDirs)) {
      const src = ws.repoDirs[repo] as string;
      const branch = runBranch(runId);
      const has = await git(src, "rev-parse", "--verify", "-q", `refs/heads/${branch}`).then(
        () => true,
        () => false,
      );
      const dst = join(dir, "oracle", repo);
      await cloneLocal(src, dst, has ? { branch } : {});
      checkouts[repo] = dst;
    }
    const open = o.sandboxOf ?? defaultSandbox;
    const verdict = await checkOracle({
      oracle,
      taskDir: o.entry.file.replace(/[/\\][^/\\]*$/, ""),
      workspace: o.suite.workspace,
      checkoutOf: (repo) => checkouts[repo] as string,
      base: ws.base,
      sandboxOf: (hostDir, project) => open(loaded.config, hostDir, project),
      timeoutMs: loaded.config.limits.gate_timeout_ms,
    });
    return done(verdict.solved ? "solved" : "unsolved", verdict.failures);
  } catch (e) {
    return result("error", { error: e instanceof Error ? e.message : String(e) });
  } finally {
    rt?.close();
  }
}

export async function runEval(o: {
  suite: Suite;
  taskIds?: string[];
  tags?: string[];
  runs: number;
  label: string;
  out: string;
  resume: boolean;
  evalHome: string;
  realHome: string;
  deps?: Deps;
  sandboxOf?: OracleSandbox;
  log?: (line: string) => void;
}): Promise<{
  results: EvalRunResult[];
  skipped: { id: string; reason: string }[];
  summary: Summary;
}> {
  segment("label", o.label);
  const log = o.log ?? (() => {});
  const skipped: { id: string; reason: string }[] = [];
  const wanted = o.suite.tasks.filter((t) => {
    if (o.taskIds?.length && !o.taskIds.includes(t.check.id)) return false;
    if (o.tags?.length && !t.task?.tags.some((tag) => o.tags?.includes(tag))) return false;
    return true;
  });
  const ready: SuiteTask[] = [];
  for (const t of wanted) {
    if (t.check.status === "ready") ready.push(t);
    else
      skipped.push({
        id: t.check.id,
        reason:
          t.check.status === "needs_oracle"
            ? "needs_oracle"
            : `invalid: ${t.check.issues[0] ?? "unknown"}`,
      });
  }
  const known = new Set(o.suite.tasks.map((t) => t.check.id));
  for (const id of o.taskIds ?? [])
    if (!known.has(id)) skipped.push({ id, reason: "unknown task" });

  const results: EvalRunResult[] = [];
  for (const entry of ready) {
    const id = (entry.task as { id: string }).id;
    for (let k = 1; k <= o.runs; k++) {
      if (o.resume && resultExists(o.out, o.label, id, k)) {
        const stored = JSON.parse(
          readFileSync(join(o.out, o.label, id, `run-${k}.json`), "utf8"),
        ) as EvalRunResult;
        results.push(stored);
        log(`${id} run ${k}: ${stored.status} (kept)`);
        continue;
      }
      const r = await runEvalTask({
        suite: o.suite,
        entry,
        run: k,
        label: o.label,
        evalHome: o.evalHome,
        realHome: o.realHome,
        ...(o.deps ? { deps: o.deps } : {}),
        ...(o.sandboxOf ? { sandboxOf: o.sandboxOf } : {}),
      });
      writeResult(o.out, r);
      results.push(r);
      log(`${id} run ${k}: ${r.status}`);
    }
  }
  return { results, skipped, summary: summarize(readResults(o.out, o.label), o.label) };
}
