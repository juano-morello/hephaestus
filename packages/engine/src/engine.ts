import { join } from "node:path";
import {
  type Brief,
  briefHash,
  type Complexity,
  complexitySanity,
  DEFAULT_LIMITS,
  deriveEdges,
  type GateResult,
  type Plan,
  type Return,
  reachability,
  type Task,
  topoOrder,
  type UnitBrief,
  WorkerResult,
  type Workspace,
} from "@hephaestus/core";
import type { EventDraft, Ledger } from "@hephaestus/ledger";
import { configHash, type EngineConfig, providerOf, ROLE_BY_KIND, resolveRoute } from "./config.ts";
import { buildContextPack } from "./context.ts";
import type { UnitGate } from "./gates.ts";
import { createGit } from "./git.ts";
import type { SpawnOutput, Worker } from "./worker.ts";

const RETURN_INSTRUCTION = "fix only the listed failures; do not modify locked paths";

/** The changeset branch (SPEC section 4). */
export const runBranch = (run: string) => `heph/${run}`;

/**
 * One branch per attempt (SPEC section 13). Not under `heph/<run>/`: git cannot hold a branch
 * and a directory of branches with the same name, so `heph/<run>` would block `heph/<run>/...`.
 */
export const attemptBranch = (run: string, unit: string, n: number) =>
  `heph-attempt/${run}/${unit}/a${n}`;

export type RunPlanOptions = {
  ledger: Ledger;
  workspace: Workspace;
  repoDir: string;
  baseRef: string;
  brief: Brief;
  /** Already through the plan gates and approved. */
  plan: Plan;
  runId: string;
  changesetId: string;
  worker: Worker;
  gates: UnitGate[];
  config: EngineConfig;
  worktreesDir: string;
  eval?: boolean;
};

export type RunOutcome = {
  status: "finished" | "paused";
  runBranch: string;
  runBranchSha: string;
  reason?: string;
};

type Ctx = RunPlanOptions & { repo: string; hash: string };

function singleRepo(workspace: Workspace, plan: Plan): string {
  const repos = new Set(
    plan.tasks.map((t) => {
      const project = workspace.projects[t.project];
      if (!project) throw new Error(`task ${t.id}: unknown project ${t.project}`);
      return project.repo;
    }),
  );
  if (repos.size !== 1) throw new Error("multi-repo changesets are v0 step 2.5");
  return [...repos][0] as string;
}

const toProjectPath = (projectPath: string, repoPath: string) => {
  const prefix = projectPath === "." ? "" : `${projectPath.replace(/\/$/, "")}/`;
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : undefined;
};

/**
 * Runs an approved plan one unit at a time, in derived order. Each unit loops through
 * produce, check, correct for at most `config.maxAttempts` attempts (SPEC section 2).
 */
export async function runPlan(opts: RunPlanOptions): Promise<RunOutcome> {
  const repo = singleRepo(opts.workspace, opts.plan);
  if (opts.plan.brief_hash !== briefHash(opts.brief)) {
    throw new Error("plan brief_hash does not match the brief");
  }
  const ids = opts.plan.tasks.map((t) => t.id);
  const { edges } = deriveEdges(opts.plan.tasks);
  const order = topoOrder(ids, edges);
  if (!order.ok) throw new Error(`plan has a cycle: ${order.cycle.join(" -> ")}`);

  const ctx: Ctx = {
    ...opts,
    repo,
    hash: configHash(
      opts.config,
      opts.gates.map((g) => g.name),
    ),
  };
  const { ledger, runId } = opts;
  const git = createGit(opts.repoDir);
  const branch = runBranch(runId);
  const base = { run_id: runId, changeset_id: opts.changesetId, config_hash: ctx.hash, repo };
  const engine = { ...base, actor: "engine" as const };

  const tiers = new Map<string, Complexity>(opts.plan.tasks.map((t) => [t.id, t.complexity]));
  const sanity = complexitySanity(opts.plan, {
    brief: opts.brief,
    workspace: opts.workspace,
    limits: DEFAULT_LIMITS,
    projectGates: {},
  });
  for (const b of sanity.bumps) tiers.set(b.task, b.to);

  const baseSha = await git.revParse(opts.baseRef);
  await git.branchForce(branch, baseSha);
  ledger.appendMany([
    {
      ...engine,
      type: "run.created",
      data: {
        owner_node: ledger.nodeId,
        brief_hash: opts.plan.brief_hash,
        eval: opts.eval ?? false,
      },
    },
    { ...engine, type: "run.plan_ready", data: { plan: opts.plan } },
    { ...engine, type: "node.started", graph_node: "build", data: {} },
  ]);

  const reach = reachability(ids, edges);
  const accepted = new Map<string, string[]>();
  const byId = new Map(opts.plan.tasks.map((t) => [t.id, t]));

  for (const id of order.order) {
    const t = byId.get(id) as Task;
    const projectPath = opts.workspace.projects[t.project]?.path ?? ".";
    // Test locking (SPEC section 8): files from accepted test tasks that precede this one.
    const locked = [...accepted]
      .filter(([u]) => byId.get(u)?.kind === "test" && byId.get(u)?.project === t.project)
      .filter(([u]) => reach.get(u)?.has(id))
      .flatMap(([, files]) => files)
      .flatMap((f) => toProjectPath(projectPath, f) ?? [])
      .sort();

    const result = await runUnit(ctx, t, tiers.get(id) as Complexity, projectPath, locked);
    if (result.status === "paused") {
      return {
        status: "paused",
        runBranch: branch,
        runBranchSha: await git.revParse(branch),
        reason: `${id}: ${result.reason}`,
      };
    }
    accepted.set(id, result.files);
  }

  ledger.appendMany([
    { ...engine, type: "node.finished", graph_node: "build", data: { outcome: "ok" } },
    { ...engine, type: "run.finished", data: {} },
  ]);
  return { status: "finished", runBranch: branch, runBranchSha: await git.revParse(branch) };
}

type UnitResult = { status: "accepted"; files: string[] } | { status: "paused"; reason: string };

async function runUnit(
  ctx: Ctx,
  t: Task,
  tier: Complexity,
  projectPath: string,
  locked: string[],
): Promise<UnitResult> {
  const { ledger, config } = ctx;
  const git = createGit(ctx.repoDir);
  const branch = runBranch(ctx.runId);
  const role = ROLE_BY_KIND[t.kind];
  const route = resolveRoute(config, role, tier);
  const info = {
    role,
    tier,
    model: route.model,
    provider: providerOf(route.model),
    ...(route.effort ? { effort: route.effort } : {}),
  };
  const unit = {
    run_id: ctx.runId,
    changeset_id: ctx.changesetId,
    config_hash: ctx.hash,
    repo: ctx.repo,
    project: t.project,
    unit_id: t.id,
  };
  const project = {
    name: t.project,
    stack: ctx.workspace.projects[t.project]?.stack ?? "unknown",
    commands: config.commands[t.project] ?? {},
  };

  let feedback: Return | undefined;
  for (let n = 1; n <= config.maxAttempts; n++) {
    const at = { ...unit, attempt: n };
    const engine = { ...at, actor: "engine" as const };
    const tip = await git.revParse(branch);
    const worktree = join(ctx.worktreesDir, ctx.runId, t.id, `a${n}`);
    await git.worktreeAdd(worktree, attemptBranch(ctx.runId, t.id, n), tip);
    try {
      const workdir = join(worktree, projectPath === "." ? "" : projectPath);
      const built = await buildContextPack({
        git,
        worktree,
        projectPath,
        project,
        task: t,
        locked,
        constraints: ctx.brief.constraints,
        ...(feedback ? { feedback } : {}),
        budgetTokens: config.budgetTokens,
      });
      const brief: UnitBrief = {
        schema: 1,
        task: t,
        criteria: ctx.brief.acceptance.filter((c) => t.covers.includes(c.id)),
        decisions: ctx.brief.decisions,
        role,
        tier,
        context: built.pack,
        constraints: ctx.brief.constraints,
        locked_paths: locked,
        ...(feedback ? { feedback } : {}),
        output_schema: "WorkerResult",
      };
      ledger.appendMany([
        {
          ...engine,
          type: "context.pack_built",
          data: { size_tokens: built.sizeTokens, truncated: built.truncated, expansions: 0 },
        },
        { ...engine, type: "unit.attempt.started", data: info },
      ]);

      const started = Date.now();
      let out: SpawnOutput;
      try {
        out = await ctx.worker.spawn({
          role,
          brief,
          workdir,
          tools: config.tools,
          model: route.model,
          ...(route.effort ? { effort: route.effort } : {}),
        });
      } catch (e) {
        out = {
          output: undefined,
          transcript: `worker threw: ${e}`,
          usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          exit: "error",
        };
      }
      const prompt = out.prompt_hash ? { prompt_hash: out.prompt_hash } : {};

      // Interrupted or rate-limited attempts never count and never escalate (SPEC sections 10, 13).
      if (out.exit === "rate_limited" || out.exit === "interrupted") {
        const reason = out.exit === "rate_limited" ? "rate_limit" : "user";
        ledger.appendMany([
          {
            ...engine,
            ...prompt,
            type: "unit.attempt.interrupted",
            data: { reason },
          },
          { ...engine, type: "run.paused", data: { reason } },
        ]);
        return { status: "paused", reason };
      }

      const sha = await git.commitAll(worktree, `heph: ${ctx.runId} ${t.id} a${n}`);
      const diff = await git.diff(tip, sha);
      const blobs = {
        diff: ledger.blobs.put(diff.text),
        transcript: ledger.blobs.put(out.transcript),
      };

      const parsed = WorkerResult.safeParse(out.output);
      const failures: GateResult[] = [];
      let outcome: "green" | "red" | "blocked" | "error";
      const gateEvents: EventDraft[] = [];
      if (out.exit === "error" || !parsed.success) {
        outcome = "error";
        const evidence = parsed.success
          ? [`worker exited with an error`]
          : parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
        const r: GateResult = {
          gate: "worker_output",
          verdict: "fail",
          reason: parsed.success
            ? "worker exited with an error"
            : "worker output does not match WorkerResult",
          evidence,
        };
        failures.push(r);
        gateEvents.push({ ...at, actor: "gate", type: "gate.result", data: r });
      } else if (parsed.data.blocked) {
        outcome = "blocked";
      } else {
        for (const gate of ctx.gates) {
          let r: GateResult;
          try {
            r = await gate.run({
              task: t,
              attempt: n,
              project: t.project,
              projectPath,
              workdir,
              diff,
              lockedPaths: locked,
              worker: parsed.data,
            });
          } catch (e) {
            r = {
              gate: gate.name,
              verdict: "fail",
              reason: `gate crashed: ${e}`,
              evidence: [String(e)],
            };
          }
          gateEvents.push({ ...at, actor: "gate", type: "gate.result", data: r });
          if (r.verdict === "fail") failures.push(r);
        }
        outcome = failures.length ? "red" : "green";
      }

      ledger.appendMany([
        ...gateEvents,
        {
          ...at,
          ...prompt,
          actor: "worker",
          type: "unit.attempt.finished",
          blobs,
          data: { ...info, usage: out.usage, duration_ms: Date.now() - started, outcome },
        },
      ]);

      if (outcome === "blocked" && parsed.success) {
        const reason = `blocked: ${parsed.data.blocked?.reason}`;
        ledger.appendMany([
          { ...engine, type: "unit.escalated", data: { reason } },
          { ...engine, type: "run.paused", data: { reason: "user" } },
        ]);
        return { status: "paused", reason };
      }

      if (outcome === "green") {
        await git.updateRef(branch, sha, tip);
        ledger.append({ ...engine, type: "unit.accepted", data: {} });
        return { status: "accepted", files: diff.files };
      }

      feedback = {
        schema: 1,
        unit_id: t.id,
        attempt: n,
        verdict: "red",
        reasons: failures.map((f) => ({
          gate: f.gate,
          reason: f.reason,
          evidence: f.evidence.join("\n"),
        })),
        scope: t.scope,
        instruction: RETURN_INSTRUCTION,
      };
      ledger.append({ ...engine, type: "unit.returned", data: feedback });
    } finally {
      await git.worktreeRemove(worktree);
    }
  }

  const reason = `red after ${config.maxAttempts} attempts`;
  const engine = { ...unit, actor: "engine" as const };
  ledger.appendMany([
    { ...engine, type: "unit.escalated", data: { reason } },
    { ...engine, type: "run.paused", data: { reason: "user" } },
  ]);
  return { status: "paused", reason };
}
