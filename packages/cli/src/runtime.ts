// The runtime facade: every operation the CLI performs on this node's ledger. The 2.8 daemon
// wraps the same functions; the CLI is then its client.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  Brief,
  briefGate,
  deriveEdges,
  type GateResult,
  type Plan,
  type ProjectGates,
  type ResolvedConfig,
  topoOrder,
  type Workspace,
} from "@hephaestus/core";
import {
  buildRun,
  builtinGates,
  checkChangeset,
  configHash,
  createRun,
  type EngineConfig,
  ghPullRequests,
  type LandOptions,
  landChangeset,
  mergeChangeset,
  type PullRequests,
  projectFiles,
  type RunPlanOptions,
  recordEscalation,
  recordPlan,
  type Worker,
} from "@hephaestus/engine";
import { type EventDraft, type Ledger, type LedgerEvent, openLedger } from "@hephaestus/ledger";
import { openSandbox, removeContainers, type SandboxSpec } from "@hephaestus/sandbox";
// OMP (and its native addon) loads only when this node plans or builds: status, sync, peer
// and the daemon's routing work without it.
import type { PlannerInput, PlannerResult } from "@hephaestus/workers";

const workers = () => import("@hephaestus/workers");

import type { LoadedConfig } from "./config.ts";
import { lockRun } from "./lock.ts";

/** Injection points for tests; production uses OMP, the gh CLI and the configured sandboxes. */
export type Deps = {
  planner?: (input: PlannerInput) => Promise<PlannerResult>;
  worker?: Worker;
  prs?: PullRequests;
  /** The clock and the wait for a rate limit to pass. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const PLANNER_ATTEMPTS = 3;
/** How long a rate-limited run waits when the provider gave no retry_after. */
const DEFAULT_RETRY_MS = 60_000;
const BUILTIN_GATES = builtinGates().map((g) => g.name);
const TERMINAL = new Set(["failed", "finished"]);

export type TaskSummary = {
  id: string;
  title: string;
  kind: string;
  project: string;
  lane: string;
  complexity: string;
};
export type PlanResult = {
  run_id: string;
  status: "planned" | "escalated" | "failed";
  plan_id?: string;
  tasks?: TaskSummary[];
  escalate?: string[];
  reason?: string;
  planner_attempts: number;
};

const summary = (plan: Plan): TaskSummary[] =>
  plan.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    kind: t.kind,
    project: t.project,
    lane: t.lane,
    complexity: t.complexity,
  }));

export function newRunId(now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `r-${day}-${randomBytes(3).toString("hex")}`;
}

export type Runtime = ReturnType<typeof openRuntime>;

export function openRuntime(opts: {
  loaded: LoadedConfig;
  workspaceDir: string;
  home: string;
  deps?: Deps;
  onAppend?: (events: LedgerEvent[]) => void;
  /** Human progress lines that are not events (e.g. waiting out a rate limit). */
  notify?: (line: string) => void;
  /** The node's ledger when several runtimes (one per workspace) share it; closed by its owner. */
  ledger?: Ledger;
}) {
  const { config } = opts.loaded;
  const deps = opts.deps ?? {};
  const ownLedger = !opts.ledger;
  const ledger: Ledger =
    opts.ledger ??
    openLedger(opts.home, {
      nodeId: config.node.id,
      ...(opts.onAppend ? { onAppend: opts.onAppend } : {}),
    });
  const { targets, name: _name, ...workspaceWithIntegration } = config.workspace;
  const workspace: Workspace = workspaceWithIntegration;
  const engineConfig = toEngineConfig(config);
  const gates = builtinGates();
  const projectGates: ProjectGates = Object.fromEntries(
    Object.keys(workspace.projects).map((p) => [
      p,
      [...BUILTIN_GATES, ...(config.projects[p]?.gates ?? [])],
    ]),
  );
  const hash = configHash(
    engineConfig,
    gates.map((g) => g.name),
  );
  // Every container carries its run, so a process that was killed can have them removed.
  const labels = (runId: string) => ({ "heph.run": runId, "heph.node": config.node.id });
  const sandboxFor = (runId: string, project: string | undefined, hostDir: string): SandboxSpec =>
    config.sandbox.mode === "native"
      ? { mode: "native", hostDir }
      : {
          mode: "container",
          hostDir,
          image: (project ? config.projects[project]?.image : undefined) ?? config.sandbox.image,
          runtime: config.sandbox.runtime,
          labels: labels(runId),
        };
  const integrationSpec = (runId: string, dir: string): SandboxSpec =>
    config.sandbox.mode === "native"
      ? { mode: "native", hostDir: dir }
      : {
          mode: "container",
          hostDir: dir,
          image: config.sandbox.integration_image ?? config.sandbox.image,
          runtime: config.sandbox.runtime,
          labels: labels(runId),
        };
  const reapSandboxes = (runId: string) => async () => {
    if (config.sandbox.mode === "container")
      await removeContainers(config.sandbox.runtime, labels(runId));
  };
  const worker = (runId: string): Worker =>
    deps.worker ??
    ({
      async spawn(input) {
        const { createOmpWorker } = await workers();
        return createOmpWorker({
          sandbox: (i) => sandboxFor(runId, i.brief.task.project, i.workdir),
        }).spawn(input);
      },
    } satisfies Worker);
  const prs = (): PullRequests => deps.prs ?? ghPullRequests();
  const planner =
    deps.planner ?? (async (input: PlannerInput) => (await workers()).runPlanner(input));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const locked = async <T>(runId: string, fn: () => Promise<T>): Promise<T> => {
    const release = lockRun(opts.home, runId);
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const runRow = (runId: string) => {
    const row = ledger.run(runId);
    if (!row) throw new Error(`no run ${runId}`);
    return row;
  };
  const created = (runId: string) => {
    const e = ledger.read({ run_id: runId, types: ["run.created"] }).at(-1)?.event;
    const data = e?.data as { brief?: unknown; workspace_root?: string } | undefined;
    if (!data?.brief) throw new Error(`run ${runId} has no recorded brief`);
    // The run's workspace on this node is the one this runtime was opened for: a run taken
    // over from another node lives in this node's own checkout (SPEC section 7).
    return {
      brief: Brief.parse(data.brief),
      workspaceRoot: opts.workspaceDir,
      changesetId: e?.changeset_id ?? runId,
    };
  };
  /** A planner that started and never finished: the process running it was stopped. */
  const plannerInterrupted = (runId: string) => {
    const last = ledger
      .read({ run_id: runId, types: ["node.started", "node.finished"] })
      .map((s) => s.event)
      .filter((e) => e.graph_node === "plan")
      .at(-1);
    return last?.type === "node.started";
  };
  const latestPlan = (runId: string) => {
    const e = ledger.read({ run_id: runId, types: ["run.plan_ready"] }).at(-1)?.event;
    if (!e) throw new Error(`run ${runId} has no plan`);
    return { id: e.id, plan: (e.data as { plan: Plan }).plan };
  };
  const approvedPlan = (runId: string) => {
    const latest = ledger.read({ run_id: runId, types: ["run.plan_ready"] }).at(-1)?.event.id;
    return ledger.read({ run_id: runId, types: ["human.input"] }).some((s) => {
      const d = s.event.data as { kind: string; target?: string; plan?: string };
      return d.kind === "approve" && d.target === "plan" && d.plan === latest;
    });
  };
  const human = (
    runId: string,
    changesetId: string,
    extra: Partial<EventDraft> & Pick<EventDraft, "type" | "data">,
  ) =>
    ledger.append({
      run_id: runId,
      changeset_id: changesetId,
      config_hash: hash,
      actor: "human",
      ...extra,
    } as EventDraft);
  const meta = (runId: string, brief: Brief, workspaceRoot: string, changesetId: string) => ({
    ledger,
    brief,
    runId,
    changesetId,
    workspaceRoot,
    workspaceName: config.workspace.name,
    config: engineConfig,
    gates,
    workspace,
  });
  const runOptions = (runId: string): Omit<RunPlanOptions, "brief" | "plan"> & { brief: Brief } => {
    const c = created(runId);
    return {
      ledger,
      workspace,
      workspaceRoot: c.workspaceRoot,
      ...(targets ? { targets } : {}),
      runId,
      changesetId: c.changesetId,
      worker: worker(runId),
      gates,
      config: engineConfig,
      worktreesDir: join(opts.home, "worktrees"),
      gateSandbox: (workdir, t) => openSandbox(sandboxFor(runId, t.project, workdir)),
      integrationSandbox: (dir) => openSandbox(integrationSpec(runId, dir)),
      reapSandboxes: reapSandboxes(runId),
      prs: prs(),
      brief: c.brief,
    };
  };
  const landOptions = (runId: string): LandOptions => {
    const o = runOptions(runId);
    return { ...o, plan: latestPlan(runId).plan, prs: prs() };
  };

  /** A run paused by a rate limit waits until the provider's retry_after; returns when that was. */
  async function waitOutRateLimit(runId: string): Promise<string | undefined> {
    if (runRow(runId).status !== "paused") return undefined;
    const paused = ledger.read({ run_id: runId, types: ["run.paused"] }).at(-1)?.event;
    const d = paused?.data as { reason: string; retry_after?: string } | undefined;
    if (!paused || d?.reason !== "rate_limit") return undefined;
    const until = d.retry_after
      ? Date.parse(d.retry_after)
      : Date.parse(paused.ts) + DEFAULT_RETRY_MS;
    const ms = until - now();
    const at = new Date(until).toISOString();
    if (ms > 0) {
      opts.notify?.(`rate limited; continuing at ${at} (heph run ${runId} --now to skip)`);
      await sleep(ms);
    }
    return at;
  }

  /** The planner loop: up to 3 answers, failed plan gates fed back each time (SPEC section 2). */
  async function plan(
    runId: string,
    brief: Brief,
    workspaceRoot: string,
    changesetId: string,
    extra: Partial<PlannerInput> = {},
  ): Promise<PlanResult> {
    const files = await projectFiles(workspace, workspaceRoot);
    const route = config.routing.planner?.default ?? config.routing.planner?.standard;
    if (!route) throw new Error("no route for the planner role");
    const m = meta(runId, brief, workspaceRoot, changesetId);
    const base = { run_id: runId, changeset_id: changesetId, config_hash: hash };
    ledger.append({ ...base, actor: "engine", type: "node.started", graph_node: "plan", data: {} });
    let feedback: GateResult[] | undefined;
    for (let attempt = 1; attempt <= PLANNER_ATTEMPTS; attempt++) {
      const r = await planner({
        brief,
        workspace,
        projectGates,
        files,
        repoMap: (await workers()).repoMapFromFiles(files),
        route,
        ...extra,
        ...(feedback ? { feedback } : {}),
      });
      const ev = r.evaluation;
      const done = (outcome: string) =>
        ledger.append({
          ...base,
          actor: "engine",
          type: "node.finished",
          graph_node: "plan",
          data: { outcome },
        });
      if (ev.escalate) {
        recordEscalation(m, ev.escalate);
        done("escalated");
        return {
          run_id: runId,
          status: "escalated",
          escalate: ev.escalate,
          planner_attempts: attempt,
        };
      }
      if (ev.plan && ev.valid) {
        const planId = recordPlan(m, ev.plan);
        done("planned");
        return {
          run_id: runId,
          status: "planned",
          plan_id: planId,
          tasks: summary(ev.plan),
          planner_attempts: attempt,
        };
      }
      // Invalid: record what failed, and hand it back to the planner.
      const failed: GateResult[] = ev.gates.filter((g) => g.verdict === "fail");
      if (ev.error)
        failed.unshift({
          gate: "plan_schema",
          verdict: "fail",
          reason: "the answer is not a valid Plan",
          evidence: [ev.error],
        });
      ledger.appendMany(
        failed.map(
          (g) =>
            ({
              ...base,
              actor: "gate",
              graph_node: "plan",
              type: "gate.result",
              data: g,
            }) as EventDraft,
        ),
      );
      feedback = failed;
    }
    const reason = `the planner produced no valid plan in ${PLANNER_ATTEMPTS} attempts`;
    ledger.appendMany([
      {
        ...base,
        actor: "engine",
        type: "node.finished",
        graph_node: "plan",
        data: { outcome: "failed" },
      },
      { ...base, actor: "engine", type: "run.failed", data: { reason } },
    ]);
    return { run_id: runId, status: "failed", reason, planner_attempts: PLANNER_ATTEMPTS };
  }

  return {
    ledger,
    close: () => {
      if (ownLedger) ledger.close();
    },

    async newRun(briefInput: unknown, o: { runId?: string } = {}): Promise<PlanResult> {
      const brief = Brief.parse(briefInput);
      const gate = briefGate(brief, workspace, projectGates);
      if (gate.verdict === "fail") throw new Error(`brief gate: ${gate.evidence.join("; ")}`);
      const runId = o.runId ?? newRunId();
      if (ledger.run(runId)) throw new Error(`run ${runId} already exists`);
      createRun(meta(runId, brief, opts.workspaceDir, runId));
      return plan(runId, brief, opts.workspaceDir, runId);
    },

    /**
     * heph plan revise: plans again with your instructions. A run with no plan yet (its planner
     * was stopped) is planned from the Brief, instructions optional (SPEC section 13).
     */
    async revise(runId: string, instructions: string): Promise<PlanResult> {
      const row = runRow(runId);
      if (TERMINAL.has(row.status)) throw new Error(`run ${runId} is ${row.status}`);
      return locked(runId, async () => {
        const c = created(runId);
        const hasPlan = ledger.read({ run_id: runId, types: ["run.plan_ready"] }).length > 0;
        if (hasPlan && !instructions) throw new Error("missing instructions");
        if (instructions) {
          human(runId, c.changesetId, {
            type: "human.input",
            data: { kind: "plan_edit", text: instructions },
          });
        }
        const extra: Partial<PlannerInput> = hasPlan
          ? { previous: latestPlan(runId).plan, instructions }
          : instructions
            ? { instructions }
            : {};
        return plan(runId, c.brief, c.workspaceRoot, c.changesetId, extra);
      });
    },

    planShow(runId: string) {
      runRow(runId);
      const { id, plan: p } = latestPlan(runId);
      const order = topoOrder(
        p.tasks.map((t) => t.id),
        deriveEdges(p.tasks).edges,
      );
      return {
        run_id: runId,
        plan_id: id,
        approved: approvedPlan(runId),
        order: order.ok ? order.order : [],
        tasks: summary(p),
        risks: p.risks,
      };
    },

    approvePlan(runId: string) {
      const row = runRow(runId);
      if (row.status !== "planned") throw new Error(`run ${runId} is ${row.status}, not planned`);
      const { id } = latestPlan(runId);
      human(runId, created(runId).changesetId, {
        type: "human.input",
        data: { kind: "approve", target: "plan", plan: id },
      });
      return { run_id: runId, target: "plan" as const, plan_id: id };
    },

    /**
     * heph run: build an approved plan, then stage it (PRs for review, or staging refs). Picks up
     * from where the run is: a stopped or paused build resumes, a built one is staged, and a
     * rate-limited one first waits for the limit to pass (`now` skips the wait).
     */
    async build(runId: string, o: { now?: boolean; signal?: AbortSignal } = {}) {
      const row = runRow(runId);
      if (TERMINAL.has(row.status)) throw new Error(`run ${runId} is ${row.status}`);
      if (row.status === "staged")
        throw new Error(`run ${runId} is already staged (heph approve merge ${runId})`);
      if (row.status === "escalated")
        throw new Error(`the planner escalated ${runId}; see heph explain ${runId}`);
      if (
        plannerInterrupted(runId) ||
        !ledger.read({ run_id: runId, types: ["run.plan_ready"] }).length
      )
        throw new Error(`run ${runId} has no finished plan (heph plan revise ${runId})`);
      if (!approvedPlan(runId))
        throw new Error(`the latest plan of ${runId} is not approved (heph approve plan ${runId})`);
      return locked(runId, async () => {
        const waited = o.now ? undefined : await waitOutRateLimit(runId);
        const extra = waited ? { waited_until: waited } : {};
        const { brief: _brief, ...ro } = runOptions(runId);
        let heads: Record<string, string> = {};
        if (runRow(runId).status !== "built") {
          const out = await buildRun({ ...ro, ...(o.signal ? { signal: o.signal } : {}) });
          const base = {
            run_id: runId,
            status: out.status,
            heads: out.heads,
            ...(out.reason ? { reason: out.reason } : {}),
            ...extra,
          };
          if (out.status !== "built") return base;
          heads = out.heads;
        }
        const staged = await landChangeset(landOptions(runId));
        const base = {
          run_id: runId,
          heads: Object.keys(heads).length ? heads : staged.refs,
          ...extra,
        };
        if (staged.status !== "staged")
          return { ...base, status: "paused" as const, reason: staged.reason ?? "staging failed" };
        return { ...base, status: "staged" as const, ...(staged.prs ? { prs: staged.prs } : {}) };
      });
    },

    status(runId?: string) {
      if (!runId) return { runs: ledger.runs() };
      const run = runRow(runId);
      const staged = ledger.read({ run_id: runId, types: ["merge.staged"] }).at(-1)?.event.data as
        | { prs?: Record<string, string> }
        | undefined;
      return {
        run,
        plan_approved:
          ledger.read({ run_id: runId, types: ["run.plan_ready"] }).length > 0 &&
          approvedPlan(runId),
        units: ledger.units(runId),
        attempts: ledger.attempts(runId),
        usage: ledger.usage(runId),
        ...(staged?.prs ? { prs: staged.prs } : {}),
      };
    },

    explain(runId: string, unit?: string) {
      runRow(runId);
      const events = ledger
        .read({ run_id: runId, ...(unit ? { unit_id: unit } : {}) })
        .map((s) => s.event)
        .map((e) => ({
          id: e.id,
          ts: e.ts,
          type: e.type,
          ...(e.unit_id ? { unit_id: e.unit_id } : {}),
          ...(e.attempt ? { attempt: e.attempt } : {}),
          summary: describe(e),
        }));
      return { run_id: runId, ...(unit ? { unit } : {}), events };
    },

    hint(runId: string, unit: string, text: string, budget?: number) {
      const row = runRow(runId);
      if (TERMINAL.has(row.status)) throw new Error(`run ${runId} is ${row.status}`);
      const { plan: p } = latestPlan(runId);
      if (!p.tasks.some((t) => t.id === unit)) throw new Error(`run ${runId} has no unit ${unit}`);
      const c = created(runId);
      const recorded: string[] = [];
      if (text) {
        human(runId, c.changesetId, {
          type: "human.input",
          unit_id: unit,
          data: { kind: "hint", text },
        });
        recorded.push("hint");
      }
      if (budget) {
        human(runId, c.changesetId, {
          type: "human.input",
          unit_id: unit,
          data: { kind: "budget_override", budget_tokens: budget },
        });
        recorded.push("budget_override");
      }
      return { run_id: runId, unit, recorded };
    },

    cancel(runId: string) {
      const row = runRow(runId);
      if (TERMINAL.has(row.status)) throw new Error(`run ${runId} is already ${row.status}`);
      human(runId, created(runId).changesetId, {
        type: "run.failed",
        data: { reason: "cancelled by user" },
      });
      return { run_id: runId, status: "failed" as const };
    },

    async approveMerge(runId: string) {
      const row = runRow(runId);
      if (row.status !== "staged")
        throw new Error(`run ${runId} is ${row.status}, not staged (heph run ${runId} first)`);
      human(runId, created(runId).changesetId, {
        type: "human.input",
        data: { kind: "approve", target: "merge" },
      });
      return locked(runId, async () => ({
        run_id: runId,
        result: await mergeChangeset(landOptions(runId)),
      }));
    },

    async mergeStatus(runId: string) {
      runRow(runId);
      return { run_id: runId, result: await checkChangeset(landOptions(runId)) };
    },
  };
}

function toEngineConfig(config: ResolvedConfig): EngineConfig {
  return {
    routing: config.routing,
    maxAttempts: config.limits.attempts_per_unit,
    budgetTokens: config.limits.budget_tokens,
    gateTimeoutMs: config.limits.gate_timeout_ms,
    tools: [],
    commands: Object.fromEntries(Object.entries(config.projects).map(([p, s]) => [p, s.commands])),
  };
}

/** One readable line per event for heph explain and progress output. */
export function describe(e: { type: string; data: unknown; attempt?: number | undefined }): string {
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case "gate.result": {
      const g = d as unknown as GateResult;
      return `${g.gate} ${g.verdict}: ${g.reason}${g.evidence.length ? ` (${g.evidence.join("; ")})` : ""}`;
    }
    case "unit.attempt.finished":
      return `attempt ${e.attempt} ${d.outcome} with ${d.model}`;
    case "unit.attempt.started":
      return `attempt ${e.attempt} started (${d.role}, ${d.model})`;
    case "unit.returned":
      return `returned: ${((d.reasons as { gate: string; reason: string }[]) ?? []).map((r) => `${r.gate}: ${r.reason}`).join("; ")}`;
    case "run.plan_ready":
      return `plan ready: ${((d.plan as Plan).tasks ?? []).map((t) => t.id).join(", ")}`;
    case "run.plan_escalated":
      return `escalated: ${(d.reasons as string[]).join("; ")}`;
    case "human.input":
      return `${d.kind}${d.target ? ` ${d.target}` : ""}${d.text ? `: ${d.text}` : ""}${d.budget_tokens ? ` (${d.budget_tokens} tokens)` : ""}`;
    case "effect.intended":
      return `${String(d.effect).replaceAll("_", " ")}: ${d.target}${d.after ? ` to ${String(d.after).slice(0, 7)}` : ""}`;
    case "effect.done":
      return `${String(d.effect).replaceAll("_", " ")} ${d.state}${d.sha ? ` (${String(d.sha).slice(0, 7)})` : ""}${d.url ? ` ${d.url}` : ""}`;
    case "run.handed_off":
      return `handed off to ${d.to}`;
    case "merge.staged":
      return d.prs
        ? `staged as pull requests: ${Object.values(d.prs as object).join(", ")}`
        : "staged";
    default: {
      const reason =
        typeof d.reason === "string"
          ? `: ${d.reason}`
          : typeof d.outcome === "string"
            ? `: ${d.outcome}`
            : "";
      return `${e.type.replaceAll(".", " ")}${reason}`;
    }
  }
}
