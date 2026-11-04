import { join, resolve } from "node:path";
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
import type { EventDraft, Ledger, LedgerEvent } from "@hephaestus/ledger";
import type { Sandbox } from "@hephaestus/sandbox";
import { configHash, type EngineConfig, providerOf, ROLE_BY_KIND, resolveRoute } from "./config.ts";
import { buildContextPack } from "./context.ts";
import { type Chaos, clearWorktrees, effect, type Reality, reconcile, Stopped } from "./effects.ts";
import type { UnitGate } from "./gates.ts";
import { createGit, type Git } from "./git.ts";
import { runIntegrationGate } from "./integration.ts";
import { landChangeset, mergeChangeset } from "./land.ts";
import { projectRelative } from "./paths.ts";
import type { PullRequests } from "./prs.ts";
import type { SpawnOutput, Worker } from "./worker.ts";

const RETURN_INSTRUCTION = "fix only the listed failures; do not modify locked paths";
const DEFAULT_GATE_TIMEOUT_MS = 10 * 60_000;

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
  /** Repo paths in the workspace resolve against this. */
  workspaceRoot: string;
  /** Repo -> target branch the changeset lands on. Default "main". */
  targets?: Record<string, string>;
  brief: Brief;
  /** Already through the plan gates and approved. */
  plan: Plan;
  runId: string;
  changesetId: string;
  worker: Worker;
  gates: UnitGate[];
  config: EngineConfig;
  worktreesDir: string;
  /** Opens a sandbox over an attempt's project dir for the command gates; same spec as the worker's. */
  gateSandbox?: (workdir: string, task: Task) => Promise<Sandbox>;
  /** Opens a sandbox over the assembled changeset for the workspace integration gate. */
  integrationSandbox?: (dir: string) => Promise<Sandbox>;
  /** Land right after a clean build, but only if every unit is lane contained (SPEC section 2). */
  autoMerge?: boolean;
  /** Used when the touched repos have a remote: the changeset lands as pull requests. */
  prs?: PullRequests;
  eval?: boolean;
  /**
   * Removes sandboxes a stopped process left for this run (containers are never disposed when
   * the process is killed). Called wherever leftover worktrees are cleared.
   */
  reapSandboxes?: () => Promise<void>;
  /** Tests only: called before and after every effect (see effects.ts). */
  chaos?: Chaos;
};

export type RunOutcome = {
  /** built: ready to land. staged: pull requests open. landed: targets fast-forwarded. */
  status: "built" | "paused" | "staged" | "landed" | "cancelled";
  runBranch: string;
  /** Run-branch tip per touched repo. */
  heads: Record<string, string>;
  prs?: Record<string, string>;
  reason?: string;
};

type Ctx = RunPlanOptions & {
  hash: string;
  base: { run_id: string; changeset_id: string; config_hash: string };
  repoOf: (t: Task) => string;
  dirOf: (repo: string) => string;
};

/** The repos the plan touches, in first-use order. Unknown projects or repos are errors. */
export function touchedRepos(workspace: Workspace, plan: Plan): string[] {
  const repos: string[] = [];
  for (const t of plan.tasks) {
    const project = workspace.projects[t.project];
    if (!project) throw new Error(`task ${t.id}: unknown project ${t.project}`);
    if (!(project.repo in workspace.repos))
      throw new Error(`project ${t.project}: unknown repo ${project.repo}`);
    if (!repos.includes(project.repo)) repos.push(project.repo);
  }
  return repos;
}

/**
 * Runs an approved plan one unit at a time, in derived order. Each unit loops through
 * produce, check, correct for at most `config.maxAttempts` attempts (SPEC section 2).
 */
export async function runPlan(opts: RunPlanOptions): Promise<RunOutcome> {
  validatePlan(opts.workspace, opts.brief, opts.plan);
  createRun(opts);
  recordPlan(opts, opts.plan);
  return build(opts);
}

type RunMeta = Pick<
  RunPlanOptions,
  "ledger" | "brief" | "runId" | "changesetId" | "workspaceRoot" | "config" | "gates" | "eval"
>;

const runEvent = (o: Pick<RunPlanOptions, "runId" | "changesetId" | "config" | "gates">) => ({
  run_id: o.runId,
  changeset_id: o.changesetId,
  config_hash: configHash(
    o.config,
    o.gates.map((g) => g.name),
  ),
  actor: "engine" as const,
});

/** Throws before anything is written if the plan can't run in this workspace. */
export function validatePlan(workspace: Workspace, brief: Brief, plan: Plan): void {
  touchedRepos(workspace, plan);
  if (plan.brief_hash !== briefHash(brief))
    throw new Error("plan brief_hash does not match the brief");
  const order = topoOrder(
    plan.tasks.map((t) => t.id),
    deriveEdges(plan.tasks).edges,
  );
  if (!order.ok) throw new Error(`plan has a cycle: ${order.cycle.join(" -> ")}`);
}

/** run.created, carrying the Brief and the workspace root so the run can be rebuilt later. */
export function createRun(o: RunMeta): void {
  o.ledger.append({
    ...runEvent(o),
    type: "run.created",
    data: {
      owner_node: o.ledger.nodeId,
      brief_hash: briefHash(o.brief),
      eval: o.eval ?? false,
      brief: o.brief,
      workspace_root: o.workspaceRoot,
    },
  });
}

/** run.plan_ready for a validated plan; returns the event id (what a plan approval names). */
export function recordPlan(o: RunMeta & Pick<RunPlanOptions, "workspace">, plan: Plan): string {
  validatePlan(o.workspace, o.brief, plan);
  return o.ledger.append({ ...runEvent(o), type: "run.plan_ready", data: { plan } }).id;
}

/** The planner's honest exit: the run waits for a revised Brief. */
export function recordEscalation(o: RunMeta, reasons: string[]): void {
  o.ledger.append({ ...runEvent(o), type: "run.plan_escalated", data: { reasons } });
}

/** Builds a run that was created and planned earlier, from what the ledger holds. */
export async function buildRun(opts: Omit<RunPlanOptions, "brief" | "plan">): Promise<RunOutcome> {
  const created = opts.ledger.read({ run_id: opts.runId, types: ["run.created"] }).at(-1)?.event;
  const brief = (created?.data as { brief?: Brief } | undefined)?.brief;
  if (!brief) throw new Error(`run ${opts.runId} has no recorded brief`);
  const plan = (
    opts.ledger.read({ run_id: opts.runId, types: ["run.plan_ready"] }).at(-1)?.event.data as
      | { plan: Plan }
      | undefined
  )?.plan;
  if (!plan) throw new Error(`run ${opts.runId} has no plan`);
  const status = opts.ledger.run(opts.runId)?.status;
  if (status === "failed" || status === "finished")
    throw new Error(`run ${opts.runId} is ${status}`);
  validatePlan(opts.workspace, brief, plan);
  return build({ ...opts, brief, plan });
}

/** Hints (`heph hint`) for this unit or the whole run, and a budget override for this unit. */
function humanInput(ctx: Ctx, t: Task): { constraints: string[]; budgetTokens: number } {
  const inputs = ctx.ledger
    .read({ run_id: ctx.runId, types: ["human.input"] })
    .map((s) => s.event)
    .filter((e) => !e.unit_id || e.unit_id === t.id);
  const data = (e: (typeof inputs)[number]) =>
    e.data as { kind: string; text?: string; budget_tokens?: number };
  const hints = inputs
    .filter((e) => data(e).kind === "hint" && data(e).text)
    .map((e) => `Hint from the user: ${data(e).text}`);
  const budget = inputs
    .filter((e) => e.unit_id === t.id && data(e).kind === "budget_override")
    .at(-1);
  return {
    constraints: [...ctx.brief.constraints, ...hints],
    budgetTokens: budget
      ? (data(budget).budget_tokens ?? ctx.config.budgetTokens)
      : ctx.config.budgetTokens,
  };
}

/** A run is cancelled by a run.failed written from outside (heph cancel). */
function cancelled(ledger: Ledger, runId: string): string | undefined {
  if (ledger.run(runId)?.status !== "failed") return undefined;
  const failed = ledger.read({ run_id: runId, types: ["run.failed"] }).at(-1)?.event.data as
    | { reason: string }
    | undefined;
  return failed?.reason ?? "cancelled";
}

/** What reconcile needs to look at: every workspace repo, and the pull request client. */
export function realityOf(
  opts: Pick<RunPlanOptions, "prs">,
  dirOf: (repo: string) => string,
  remote?: string,
): Reality {
  return { git: (r) => createGit(dirOf(r)), dirOf, prs: opts.prs, remote };
}

/** The run's events after its latest plan, in ledger order. */
export function sinceLatestPlan(ledger: Ledger, runId: string): LedgerEvent[] {
  const events = ledger.read({ run_id: runId }).flatMap((s) => (s.known ? [s.event] : []));
  const at = events.findLastIndex((e) => e.type === "run.plan_ready");
  return events.slice(at + 1);
}

type UnitHistory = {
  /** The next attempt number: attempts are numbered across the whole run, never reused. */
  next: number;
  /** Finished attempts since the plan or the unit's last escalation; at most maxAttempts. */
  used: number;
  feedback?: Return;
  accepted?: { attempt: number; before: string; after: string };
};

/** Per unit of the latest plan: where its attempts stand, from the ledger alone. */
function unitHistory(ledger: Ledger, runId: string): Map<string, UnitHistory> {
  const out = new Map<string, UnitHistory>();
  const get = (id: string) => {
    const h = out.get(id) ?? { next: 1, used: 0 };
    out.set(id, h);
    return h;
  };
  for (const { event: e } of ledger.read({ run_id: runId })) {
    if (e.unit_id && e.attempt) get(e.unit_id).next = Math.max(get(e.unit_id).next, e.attempt + 1);
  }
  const advances = new Map<string, { before: string; after: string }>();
  for (const e of sinceLatestPlan(ledger, runId)) {
    if (!e.unit_id) continue;
    const h = get(e.unit_id);
    if (e.type === "unit.attempt.finished") h.used++;
    else if (e.type === "unit.escalated") h.used = 0;
    else if (e.type === "unit.returned") h.feedback = e.data;
    else if (e.type === "effect.intended" && e.data.effect === "run_branch_advance") {
      if (e.data.before && e.data.after)
        advances.set(`${e.unit_id}/${e.attempt}`, { before: e.data.before, after: e.data.after });
    } else if (e.type === "unit.accepted" && e.attempt) {
      const a = advances.get(`${e.unit_id}/${e.attempt}`);
      if (a) h.accepted = { attempt: e.attempt, ...a };
    }
  }
  return out;
}

/**
 * Picks a build up where it stopped: attempts the process never finished are interrupted
 * (they don't count), then run.resumed says why the build is running again.
 */
function resume(
  ledger: Ledger,
  runId: string,
  engine: Omit<EventDraft, "type" | "data">,
  status: string | undefined,
) {
  const since = sinceLatestPlan(ledger, runId);
  const open = new Map<string, LedgerEvent>();
  for (const e of since) {
    const key = `${e.unit_id}/${e.attempt}`;
    if (e.type === "unit.attempt.started") open.set(key, e);
    if (e.type === "unit.attempt.finished" || e.type === "unit.attempt.interrupted")
      open.delete(key);
  }
  const lastPause = since.findLast((e) => e.type === "run.paused")?.data as
    | { reason: "rate_limit" | "handoff" | "user" }
    | undefined;
  const reason =
    status === "paused" ? (lastPause?.reason ?? "user") : status === "running" ? "crash" : "user";
  ledger.appendMany([
    ...[...open.values()].map(
      (e) =>
        ({
          run_id: e.run_id,
          changeset_id: e.changeset_id,
          config_hash: e.config_hash,
          ...(e.repo ? { repo: e.repo } : {}),
          ...(e.project ? { project: e.project } : {}),
          unit_id: e.unit_id,
          attempt: e.attempt,
          actor: "engine",
          type: "unit.attempt.interrupted",
          data: { reason: "crash" },
        }) as EventDraft,
    ),
    { ...engine, type: "run.resumed", data: { reason } } as EventDraft,
  ]);
}

async function build(opts: RunPlanOptions): Promise<RunOutcome> {
  const repos = touchedRepos(opts.workspace, opts.plan);
  const ids = opts.plan.tasks.map((t) => t.id);
  const { edges } = deriveEdges(opts.plan.tasks);
  const order = topoOrder(ids, edges);
  if (!order.ok) throw new Error(`plan has a cycle: ${order.cycle.join(" -> ")}`);

  const dirOf = (repo: string) => resolve(opts.workspaceRoot, opts.workspace.repos[repo] as string);
  const hash = configHash(
    opts.config,
    opts.gates.map((g) => g.name),
  );
  // Run-level events span repos, so they carry no `repo`; unit events do.
  const base = { run_id: opts.runId, changeset_id: opts.changesetId, config_hash: hash };
  const ctx: Ctx = {
    ...opts,
    base,
    dirOf,
    repoOf: (t) => opts.workspace.projects[t.project]?.repo as string,
    hash,
  };
  const { ledger, runId } = opts;
  const gits = new Map(repos.map((r) => [r, createGit(dirOf(r))]));
  const branch = runBranch(runId);
  const engine = { ...base, actor: "engine" as const };

  const tiers = new Map<string, Complexity>(opts.plan.tasks.map((t) => [t.id, t.complexity]));
  const sanity = complexitySanity(opts.plan, {
    brief: opts.brief,
    workspace: opts.workspace,
    limits: DEFAULT_LIMITS,
    projectGates: {},
  });
  for (const b of sanity.bumps) tiers.set(b.task, b.to);

  // SPEC section 13: a stopped process leaves worktrees and maybe effects it never confirmed.
  const statusBefore = ledger.run(runId)?.status;
  await clearWorktrees(
    opts.worktreesDir,
    runId,
    Object.keys(opts.workspace.repos).map((r) => createGit(dirOf(r))),
  );
  await opts.reapSandboxes?.();
  await reconcile(ledger, runId, realityOf(opts, dirOf));

  const resuming = sinceLatestPlan(ledger, runId).some(
    (e) => e.type === "node.started" && e.graph_node === "build",
  );
  const scope = { ledger, base, chaos: opts.chaos };
  if (!resuming) {
    // One changeset branch per touched repo, from its target (SPEC section 4).
    for (const [repo, git] of gits) {
      const at = await git.revParse(opts.targets?.[repo] ?? "main");
      await effect(
        scope,
        {
          effect: "run_branch_reset",
          key: `run_branch_reset:${repo}`,
          target: branch,
          before: await git.refSha(branch),
          after: at,
          on: { repo },
        },
        async () => {
          await git.branchForce(branch, at);
          return { sha: at };
        },
      );
    }
    ledger.append({ ...engine, type: "node.started", graph_node: "build", data: {} });
  } else {
    resume(ledger, runId, engine, statusBefore);
  }
  const heads = async () =>
    Object.fromEntries(
      await Promise.all([...gits].map(async ([r, g]) => [r, await g.revParse(branch)])),
    );

  const reach = reachability(ids, edges);
  const byId = new Map(opts.plan.tasks.map((t) => [t.id, t]));
  const history = unitHistory(ledger, runId);
  // Accepted units are never redone (SPEC section 13); their files still lock later units.
  const accepted = new Map<string, string[]>();
  for (const [id, h] of history) {
    if (!h.accepted || !byId.has(id)) continue;
    const t = byId.get(id) as Task;
    const git = gits.get(ctx.repoOf(t)) as Git;
    accepted.set(id, (await git.diff(h.accepted.before, h.accepted.after)).files);
  }

  for (const id of order.order) {
    if (accepted.has(id)) continue;
    const t = byId.get(id) as Task;
    const projectPath = opts.workspace.projects[t.project]?.path ?? ".";
    // Test locking (SPEC section 8): files from accepted test tasks that precede this one.
    const locked = [...accepted]
      .filter(([u]) => byId.get(u)?.kind === "test" && byId.get(u)?.project === t.project)
      .filter(([u]) => reach.get(u)?.has(id))
      .flatMap(([, files]) => files)
      .flatMap((f) => projectRelative(projectPath, f) ?? [])
      .sort();

    const stop = cancelled(ledger, runId);
    if (stop) return { status: "cancelled", runBranch: branch, heads: await heads(), reason: stop };
    const h = history.get(id) ?? { next: 1, used: 0 };
    const result = await runUnit(ctx, t, tiers.get(id) as Complexity, projectPath, locked, h);
    if (result.status === "cancelled") {
      return {
        status: "cancelled",
        runBranch: branch,
        heads: await heads(),
        reason: result.reason,
      };
    }
    if (result.status === "paused") {
      return {
        status: "paused",
        runBranch: branch,
        heads: await heads(),
        reason: `${id}: ${result.reason}`,
      };
    }
    accepted.set(id, result.files);
  }

  // The whole changeset must pass the workspace integration gate before it can land.
  const integration = await integrationGate(ctx, repos);
  ledger.append({ ...base, actor: "gate", type: "gate.result", data: integration });
  if (integration.verdict === "fail") {
    ledger.append({ ...engine, type: "run.paused", data: { reason: "user" } });
    return {
      status: "paused",
      runBranch: branch,
      heads: await heads(),
      reason: integration.reason,
    };
  }

  // Landing (staging, PRs or fast-forward) is a separate step: see land.ts.
  ledger.append({ ...engine, type: "node.finished", graph_node: "build", data: { outcome: "ok" } });
  if (opts.autoMerge && opts.plan.tasks.every((t) => t.lane === "contained")) {
    const landed = await landChangeset(opts);
    const prs = landed.prs ? { prs: landed.prs } : {};
    if (landed.status !== "staged") {
      return {
        status: "paused",
        runBranch: branch,
        heads: await heads(),
        reason: landed.reason ?? "landing failed",
        ...prs,
      };
    }
    const merged = await mergeChangeset(opts);
    if (merged.status === "merged")
      return { status: "landed", runBranch: branch, heads: await heads(), ...prs };
    if (merged.status === "not_ready")
      return { status: "staged", runBranch: branch, heads: await heads(), ...prs };
    return {
      status: "paused",
      runBranch: branch,
      heads: await heads(),
      reason: merged.reason,
      ...prs,
    };
  }
  return { status: "built", runBranch: branch, heads: await heads() };
}

/** Integration gate over the changeset: touched repos at their run branch, the rest at target. */
export function integrationGate(
  opts: Pick<
    RunPlanOptions,
    | "workspace"
    | "workspaceRoot"
    | "targets"
    | "integrationSandbox"
    | "config"
    | "worktreesDir"
    | "runId"
  >,
  touched: string[],
) {
  const refs = Object.fromEntries(
    Object.keys(opts.workspace.repos).map((r) => [
      r,
      touched.includes(r) ? runBranch(opts.runId) : (opts.targets?.[r] ?? "main"),
    ]),
  );
  return runIntegrationGate({
    workspace: opts.workspace,
    workspaceRoot: opts.workspaceRoot,
    refs,
    assembleDir: join(opts.worktreesDir, opts.runId, `_integration-${Date.now()}`),
    ...(opts.integrationSandbox ? { sandbox: opts.integrationSandbox } : {}),
    timeoutMs: opts.config.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
  });
}

type UnitResult =
  | { status: "accepted"; files: string[] }
  | { status: "paused"; reason: string }
  | { status: "cancelled"; reason: string };

async function runUnit(
  ctx: Ctx,
  t: Task,
  tier: Complexity,
  projectPath: string,
  locked: string[],
  history: UnitHistory,
): Promise<UnitResult> {
  const { ledger, config } = ctx;
  const repo = ctx.repoOf(t);
  const git = createGit(ctx.dirOf(repo));
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
    repo,
    project: t.project,
    unit_id: t.id,
  };
  const project = {
    name: t.project,
    stack: ctx.workspace.projects[t.project]?.stack ?? "unknown",
    commands: config.commands[t.project] ?? {},
  };

  let feedback: Return | undefined = history.feedback;
  for (let used = history.used, n = history.next; used < config.maxAttempts; used++, n++) {
    const stop = cancelled(ledger, ctx.runId);
    if (stop) return { status: "cancelled", reason: stop };
    const at = { ...unit, attempt: n };
    const engine = { ...at, actor: "engine" as const };
    const { constraints, budgetTokens } = humanInput(ctx, t);
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
        constraints,
        ...(feedback ? { feedback } : {}),
        budgetTokens,
      });
      const brief: UnitBrief = {
        schema: 1,
        task: t,
        criteria: ctx.brief.acceptance.filter((c) => t.covers.includes(c.id)),
        decisions: ctx.brief.decisions,
        role,
        tier,
        context: built.pack,
        constraints,
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
        if (e instanceof Stopped) throw e;
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
          {
            ...engine,
            type: "run.paused",
            data: { reason, ...(out.retry_after ? { retry_after: out.retry_after } : {}) },
          },
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
        // Gates run in a fresh sandbox over the attempt (SPEC section 11), opened only if needed.
        const sandbox =
          ctx.gateSandbox && ctx.gates.some((g) => g.needsSandbox)
            ? await ctx.gateSandbox(workdir, t)
            : undefined;
        try {
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
                commands: config.commands[t.project] ?? {},
                timeoutMs: config.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
                ...(sandbox ? { sandbox } : {}),
              });
            } catch (e) {
              if (e instanceof Stopped) throw e;
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
        } finally {
          await sandbox?.dispose();
        }
        outcome = failures.length ? "red" : "green";
      }

      // The attempt's verdict and what follows from it are written together, so a crash
      // can't leave a finished attempt without its consequence.
      const finished: EventDraft[] = [
        ...gateEvents,
        {
          ...at,
          ...prompt,
          actor: "worker",
          type: "unit.attempt.finished",
          blobs,
          data: { ...info, usage: out.usage, duration_ms: Date.now() - started, outcome },
        },
      ];

      if (outcome === "blocked" && parsed.success) {
        const reason = `blocked: ${parsed.data.blocked?.reason}`;
        ledger.appendMany([
          ...finished,
          { ...engine, type: "unit.escalated", data: { reason } },
          { ...engine, type: "run.paused", data: { reason: "user" } },
        ]);
        return { status: "paused", reason };
      }

      if (outcome === "green") {
        await effect(
          { ledger, base: ctx.base, chaos: ctx.chaos },
          {
            effect: "run_branch_advance",
            key: `run_branch_advance:${repo}:${t.id}:a${n}`,
            target: branch,
            before: tip,
            after: sha,
            on: { repo, project: t.project, unit_id: t.id, attempt: n },
          },
          async () => {
            await git.updateRef(branch, sha, tip);
            return { sha };
          },
          {
            with: finished,
            followedBy: () => [{ ...engine, type: "unit.accepted", data: {} }],
          },
        );
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
          evidence: f.evidence,
        })),
        scope: t.scope,
        instruction: RETURN_INSTRUCTION,
      };
      ledger.appendMany([...finished, { ...engine, type: "unit.returned", data: feedback }]);
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
