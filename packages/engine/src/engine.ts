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
  type Workspace,
} from "@hephaestus/core";
import type { EventDraft, Ledger, LedgerEvent } from "@hephaestus/ledger";
import type { Sandbox } from "@hephaestus/sandbox";
import { configHash, type EngineConfig, providerOf, ROLE_BY_KIND, resolveRoute } from "./config.ts";
import { type Chaos, clearWorktrees, effect, type Reality, reconcile } from "./effects.ts";
import type { UnitGate } from "./gates.ts";
import { createGit, type Git } from "./git.ts";
import { runIntegrationGate } from "./integration.ts";
import { type JoinLock, joinLocks } from "./join.ts";
import { type LandOptions, landChangeset, mergeChangeset } from "./land.ts";
import { projectRelative } from "./paths.ts";
import type { PullRequests } from "./prs.ts";
import { localRunner, type Runner, stopReason } from "./runner.ts";
import {
  PAUSE_RANK,
  type PauseReason,
  rateLimitRamp,
  schedule,
  type UnitResult,
} from "./scheduler.ts";
import { ancestorsOf, baseRef, restackChildren, stackRefs, unresolvedStack } from "./stack.ts";
import { isStalled } from "./stall.ts";
import type { Worker } from "./worker.ts";

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
  /**
   * Stops the build: before the next unit or attempt, and the worker in flight. Its reason is
   * "handoff" for a handoff to another node, anything else means the user.
   */
  signal?: AbortSignal;
  /** Who runs attempts. Default: in this process, with `worker` and `gates`. */
  runner?: Runner;
  /** Tests only: called before and after every effect (see effects.ts). */
  chaos?: Chaos;
  /**
   * The run this one is stacked on (design 3.1). Default: the run's recorded `stack_on`. Repos
   * start from the nearest unmerged ancestor's branch there (see stack.ts).
   */
  stackOn?: string;
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
  runner: Runner;
  hash: string;
  base: { run_id: string; changeset_id: string; config_hash: string };
  repoOf: (t: Task) => string;
  dirOf: (repo: string) => string;
  /** One per build(): serializes joins onto each repo's run branch. */
  join: JoinLock;
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
  | "ledger"
  | "brief"
  | "runId"
  | "changesetId"
  | "workspaceRoot"
  | "config"
  | "gates"
  | "eval"
  | "stackOn"
> & { workspaceName?: string | undefined };

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
      ...(o.workspaceName ? { workspace_name: o.workspaceName } : {}),
      ...(o.stackOn ? { stack_on: o.stackOn } : {}),
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

/**
 * Hints (`heph hint`) for this unit or the whole run, a budget override for this unit, and
 * files the user let this unit change beyond its planned scope (`heph hint --scope`).
 */
function humanInput(
  ctx: Ctx,
  t: Task,
): { constraints: string[]; budgetTokens: number; scope: string[] } {
  const inputs = ctx.ledger
    .read({ run_id: ctx.runId, types: ["human.input"] })
    .map((s) => s.event)
    .filter((e) => !e.unit_id || e.unit_id === t.id);
  const data = (e: (typeof inputs)[number]) =>
    e.data as { kind: string; text?: string; budget_tokens?: number; scope?: string[] };
  const hints = inputs
    .filter((e) => data(e).kind === "hint" && data(e).text)
    .map((e) => `Hint from the user: ${data(e).text}`);
  const budget = inputs
    .filter((e) => e.unit_id === t.id && data(e).kind === "budget_override")
    .at(-1);
  const added = inputs
    .filter((e) => e.unit_id === t.id && data(e).kind === "scope")
    .flatMap((e) => data(e).scope ?? []);
  return {
    scope: [...new Set([...t.scope, ...added])],
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
    else if (e.type === "unit.escalated" || e.type === "unit.stalled") h.used = 0;
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
  /** Written in the same batch as run.resumed: a pause a crash lost (see lostPause). */
  lost?: PauseReason,
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
    // Never a separate write: a crash between the two would hide the pause from the next resume.
    ...(lost ? [{ ...engine, type: "run.paused", data: { reason: lost } } as EventDraft] : []),
  ]);
}

function stallReason(gate: string | undefined, [a, b]: [number, number]): string {
  return `stalled: ${gate} failed the same way on a${a} and a${b}`;
}

/**
 * A pause a crash lost: a unit stopped the build (escalated, stalled, or interrupted by a rate limit or a
 * stop) but the process died before build() wrote run.paused. Only for a run still `running`.
 */
function lostPause(
  ledger: Ledger,
  runId: string,
): { reason: PauseReason; detail: string } | undefined {
  const since = sinceLatestPlan(ledger, runId);
  const from = since.findLastIndex(
    (e) => (e.type === "node.started" && e.graph_node === "build") || e.type === "run.resumed",
  );
  const tail = since.slice(from + 1);
  if (tail.some((e) => e.type === "run.paused")) return undefined;
  let lost: { reason: PauseReason; detail: string } | undefined;
  for (const e of tail) {
    const reason =
      e.type === "unit.stalled"
        ? stallReason(e.data.failing[0]?.gate, e.data.attempts)
        : ((e.data as { reason?: string }).reason ?? "");
    const pause: { reason: PauseReason; detail: string } | undefined =
      e.type === "unit.escalated" || e.type === "unit.stalled"
        ? { reason: "user", detail: `${e.unit_id}: ${reason}` }
        : e.type === "unit.attempt.interrupted" && reason in PAUSE_RANK
          ? { reason: reason as PauseReason, detail: `${e.unit_id}: ${reason}` }
          : undefined;
    if (pause && (!lost || PAUSE_RANK[pause.reason] > PAUSE_RANK[lost.reason])) lost = pause;
  }
  return lost;
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
    runner:
      opts.runner ??
      localRunner({
        worker: opts.worker,
        gates: opts.gates,
        gateSandbox: opts.gateSandbox,
        worktreesDir: opts.worktreesDir,
        tools: opts.config.tools,
        gateTimeoutMs: opts.config.gateTimeoutMs,
      }),
    base,
    dirOf,
    repoOf: (t) => opts.workspace.projects[t.project]?.repo as string,
    hash,
    join: joinLocks(),
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
  // Looked at before resume() writes run.resumed, which starts a new segment.
  const lost = resuming && statusBefore === "running" ? lostPause(ledger, runId) : undefined;
  const scope = { ledger, base, chaos: opts.chaos };
  if (!resuming) {
    const ancestors = ancestorsOf(ledger, runId, opts.stackOn);
    // An ancestor revised, paused or cancelled since: the base is unknown, so nothing starts.
    const unresolved = unresolvedStack(ancestors);
    if (unresolved) {
      ledger.append({ ...engine, type: "run.paused", data: { reason: "user" } });
      return { status: "paused", runBranch: branch, heads: {}, reason: unresolved };
    }
    // One changeset branch per touched repo, from its target (SPEC section 4), or from the
    // nearest unmerged ancestor's branch for a stacked run (design 3.1).
    for (const [repo, git] of gits) {
      const target = opts.targets?.[repo] ?? "main";
      const at = await git.revParse(await baseRef({ git, repo, ancestors, target }));
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
    resume(ledger, runId, engine, statusBefore, lost?.reason);
  }
  const heads = async () =>
    Object.fromEntries(
      await Promise.all([...gits].map(async ([r, g]) => [r, await g.revParse(branch)])),
    );
  if (lost) {
    // Paused again (with run.resumed) instead of building: an escalated unit only gets fresh
    // attempts from the user.
    return { status: "paused", runBranch: branch, heads: await heads(), reason: lost.detail };
  }

  const stopped = async (): Promise<RunOutcome> => {
    const reason = stopReason(opts.signal);
    ledger.append({ ...engine, type: "run.paused", data: { reason } });
    return { status: "paused", runBranch: branch, heads: await heads(), reason };
  };

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

  const start = async (id: string): Promise<UnitResult> => {
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
    if (stop) return { status: "cancelled", reason: stop };
    if (opts.signal?.aborted) {
      const reason = stopReason(opts.signal);
      return { status: "paused", reason, detail: reason };
    }
    const h = history.get(id) ?? { next: 1, used: 0 };
    return runUnit(ctx, t, tiers.get(id) as Complexity, projectPath, locked, h);
  };

  // Units in flight together join the run branch under ctx.join (see runUnit). Resumed from a
  // rate limit, the build starts at half its parallelism and ramps back up (SPEC section 17).
  const parallel = opts.config.parallel ?? 3;
  const ramp = rateLimitRamp(sinceLatestPlan(ledger, runId), parallel);
  const out = await schedule({
    plan: opts.plan,
    workspace: opts.workspace,
    parallel,
    ...(ramp !== undefined ? { ramp } : {}),
    accepted,
    scopeOf: (id) => humanInput(ctx, byId.get(id) as Task).scope,
    start,
    stopped: () => opts.signal?.aborted === true,
  });
  if (out.kind === "cancelled")
    return { status: "cancelled", runBranch: branch, heads: await heads(), reason: out.reason };
  if (out.kind === "paused") {
    // The one run.paused for this pause, whichever units stopped (SPEC section 4.2).
    const retry = out.retryAfter ? { retry_after: out.retryAfter } : {};
    ledger.append({ ...engine, type: "run.paused", data: { reason: out.reason, ...retry } });
    return { status: "paused", runBranch: branch, heads: await heads(), reason: out.detail };
  }
  // Drained by a stop before every unit ran: a cancel still wins over the stop.
  const stop = accepted.size < byId.size ? cancelled(ledger, runId) : undefined;
  if (stop) return { status: "cancelled", runBranch: branch, heads: await heads(), reason: stop };

  if (opts.signal?.aborted) return stopped();
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
    if (merged.status === "merged") {
      // Staged children of this run are restacked onto the target and retargeted, as after
      // `heph approve merge` (design 3.3); one that fails is paused on its own, never thrown.
      await restackChildren({ ledger, parentId: runId, options: (id) => childOptions(opts, id) });
      return { status: "landed", runBranch: branch, heads: await heads(), ...prs };
    }
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

/**
 * Landing options for a run stacked on the one `opts` built, from what the ledger holds about it:
 * its own brief, changeset and latest plan, in the same workspace, with the same gates and PRs.
 */
function childOptions(opts: RunPlanOptions, runId: string): LandOptions {
  const { worker: _w, autoMerge: _a, stackOn: _s, ...rest } = opts;
  const created = opts.ledger.read({ run_id: runId, types: ["run.created"] }).at(-1)?.event;
  const brief = (created?.data as { brief?: Brief } | undefined)?.brief;
  const plan = (
    opts.ledger.read({ run_id: runId, types: ["run.plan_ready"] }).at(-1)?.event.data as
      | { plan: Plan }
      | undefined
  )?.plan;
  if (!created || !brief || !plan) throw new Error(`run ${runId} has no recorded brief or plan`);
  return { ...rest, runId, changesetId: created.changeset_id, brief, plan };
}

/**
 * Where a repo's work starts from: `origin/<target>` when the repo has that remote (fetched
 * first, since this node's local branch may be stale), else the local target branch.
 */
export async function targetBase(git: Git, target: string): Promise<string> {
  if (await git.remoteUrl("origin")) {
    await git.fetch("origin", target);
    return `origin/${target}`;
  }
  return target;
}

/**
 * Integration gate over the changeset: touched repos at their run branch, the rest at the
 * nearest unmerged ancestor's branch for a stacked run (where one has a branch), else at target.
 */
export async function integrationGate(
  opts: Pick<
    RunPlanOptions,
    | "ledger"
    | "stackOn"
    | "workspace"
    | "workspaceRoot"
    | "targets"
    | "integrationSandbox"
    | "config"
    | "worktreesDir"
    | "runId"
  >,
  touched: string[],
): Promise<GateResult> {
  const ancestors = ancestorsOf(opts.ledger, opts.runId, opts.stackOn);
  // Never assembled against the target in place of an ancestor whose work is unknown.
  const unresolved = unresolvedStack(ancestors);
  if (unresolved) return { gate: "integration", verdict: "fail", reason: unresolved, evidence: [] };
  const refs = await stackRefs({
    workspace: opts.workspace,
    workspaceRoot: opts.workspaceRoot,
    targets: opts.targets,
    runId: opts.runId,
    touched,
    ancestors,
  });
  return runIntegrationGate({
    workspace: opts.workspace,
    workspaceRoot: opts.workspaceRoot,
    refs,
    assembleDir: join(opts.worktreesDir, opts.runId, `_integration-${Date.now()}`),
    ...(opts.integrationSandbox ? { sandbox: opts.integrationSandbox } : {}),
    timeoutMs: opts.config.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
  });
}

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
    if (ctx.signal?.aborted) {
      const reason = stopReason(ctx.signal);
      return { status: "paused", reason, detail: `${t.id}: ${reason}` };
    }
    const { constraints, budgetTokens, scope } = humanInput(ctx, t);
    const task = scope.length === t.scope.length ? t : { ...t, scope };
    const tip = await git.revParse(branch);
    const result = await ctx.runner.runAttempt(
      {
        runId: ctx.runId,
        task,
        attempt: n,
        tier,
        role,
        model: route.model,
        effort: route.effort,
        repoDir: ctx.dirOf(repo),
        projectPath,
        branch: attemptBranch(ctx.runId, t.id, n),
        tip,
        locked,
        constraints,
        budgetTokens,
        feedback,
        criteria: ctx.brief.acceptance.filter((c) => t.covers.includes(c.id)),
        decisions: ctx.brief.decisions,
        project,
        signal: ctx.signal,
      },
      {
        started: (s) =>
          ledger.appendMany([
            {
              ...engine,
              type: "context.pack_built",
              data: { size_tokens: s.sizeTokens, truncated: s.truncated, expansions: 0 },
            },
            { ...engine, type: "unit.attempt.started", data: info },
          ]),
      },
    );
    const prompt = result.promptHash ? { prompt_hash: result.promptHash } : {};

    if (result.kind === "interrupted") {
      const { reason } = result;
      ledger.appendMany([
        { ...engine, ...prompt, type: "unit.attempt.interrupted", data: { reason } },
      ]);
      const retry = result.retryAfter ? { retryAfter: result.retryAfter } : {};
      return { status: "paused", reason, detail: `${t.id}: ${reason}`, ...retry };
    }

    const { sha, diff, outcome } = result;
    const blobs = {
      diff: ledger.blobs.put(diff.text),
      transcript: ledger.blobs.put(result.transcript),
    };
    // The attempt's verdict and what follows from it are written together, so a crash
    // can't leave a finished attempt without its consequence. A join's re-gate results are part
    // of the verdict (design 4.3), so they come before unit.attempt.finished too.
    const verdictOf = (gates: GateResult[], outcome: typeof result.outcome): EventDraft[] => [
      ...gates.map((r): EventDraft => ({ ...at, actor: "gate", type: "gate.result", data: r })),
      {
        ...at,
        ...prompt,
        actor: "worker",
        type: "unit.attempt.finished",
        blobs,
        data: { ...info, usage: result.usage, duration_ms: result.durationMs, outcome },
      },
    ];
    let failures = result.gates.filter((g) => g.verdict === "fail");
    let finished = verdictOf(result.gates, outcome);

    if (outcome === "blocked") {
      const reason = `blocked: ${result.blocked}`;
      ledger.appendMany([...finished, { ...engine, type: "unit.escalated", data: { reason } }]);
      return { status: "paused", reason: "user", detail: `${t.id}: ${reason}` };
    }

    if (outcome === "green") {
      // Joins onto one repo's run branch are serialized (design 4.3). If the tip moved while
      // the attempt ran, its commit is replayed onto the new tip and the command gates re-run
      // on the combined tree; the replay is attempt-local work, the advance is the effect.
      const joined = await ctx.join(repo, async () => {
        const current = await git.revParse(branch);
        let after = sha;
        let verdict = finished;
        if (current !== tip) {
          if (!result.worker) throw new Error(`${t.id} a${n}: green attempt without a result`);
          const r = await ctx.runner.rejoin({
            runId: ctx.runId,
            task,
            attempt: n,
            repoDir: ctx.dirOf(repo),
            projectPath,
            project,
            locked,
            commit: sha,
            tip: current,
            worker: result.worker,
            signal: ctx.signal,
          });
          if (r.kind !== "joined") return r;
          after = r.sha;
          verdict = verdictOf([...result.gates, ...r.gates], outcome);
        }
        await effect(
          { ledger, base: ctx.base, chaos: ctx.chaos },
          {
            effect: "run_branch_advance",
            key: `run_branch_advance:${repo}:${t.id}:a${n}`,
            target: branch,
            before: current,
            after,
            on: { repo, project: t.project, unit_id: t.id, attempt: n },
          },
          async () => {
            await git.updateRef(branch, after, current);
            return { sha: after };
          },
          {
            with: verdict,
            followedBy: () => [{ ...engine, type: "unit.accepted", data: {} }],
          },
        );
        return { kind: "accepted" as const };
      });
      if (joined.kind === "accepted") return { status: "accepted", files: diff.files };
      if (joined.kind === "interrupted") {
        // Stopped during the re-gate: interrupted like any attempt, nothing of the join kept.
        const { reason } = joined;
        ledger.appendMany([
          { ...engine, ...prompt, type: "unit.attempt.interrupted", data: { reason } },
        ]);
        return { status: "paused", reason, detail: `${t.id}: ${reason}` };
      }
      // Red on the combined tree (or a replay conflict): the normal red path, and it counts.
      const gates = [...result.gates, ...joined.gates];
      failures = gates.filter((g) => g.verdict === "fail");
      finished = verdictOf(gates, "red");
    }

    feedback = {
      schema: 1,
      unit_id: t.id,
      attempt: n,
      verdict: "red",
      reasons: failures.map((f) => ({ gate: f.gate, reason: f.reason, evidence: f.evidence })),
      scope: task.scope,
      instruction: RETURN_INSTRUCTION,
    };
    const returned: EventDraft = { ...engine, type: "unit.returned", data: feedback };

    // The same failure twice in a row won't change with more attempts: ask the user now.
    // Checked against the ledger plus this return, so the stall is written with the verdict
    // (like an escalation); build() writes the one run.paused after the drain.
    const stall = isStalled(
      [...sinceLatestPlan(ledger, ctx.runId), returned as unknown as LedgerEvent],
      t.id,
    );
    if (stall) {
      const reason = stallReason(feedback.reasons[0]?.gate, stall.attempts);
      ledger.appendMany([
        ...finished,
        returned,
        {
          ...engine,
          type: "unit.stalled",
          data: {
            signature: stall.signature,
            attempts: stall.attempts,
            failing: feedback.reasons.map(({ gate, reason }) => ({ gate, reason })),
          },
        },
      ]);
      return { status: "paused", reason: "user", detail: `${t.id}: ${reason}` };
    }
    ledger.appendMany([...finished, returned]);
  }

  // Attempts are numbered across escalations; each escalation gives a fresh maxAttempts.
  const all = history.next + config.maxAttempts - history.used - 1;
  const reason =
    all > config.maxAttempts
      ? `red after ${config.maxAttempts} more attempts (${all} in all)`
      : `red after ${config.maxAttempts} attempts`;
  const engine = { ...unit, actor: "engine" as const };
  ledger.appendMany([{ ...engine, type: "unit.escalated", data: { reason } }]);
  return { status: "paused", reason: "user", detail: `${t.id}: ${reason}` };
}
