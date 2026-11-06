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
  ancestorRefs,
  ancestorsOf,
  buildRun,
  builtinGates,
  checkChangeset,
  configHash,
  createRun,
  diagnose,
  dropJoinPins,
  type EngineConfig,
  ghPullRequests,
  type LandOptions,
  landChangeset,
  mergeChangeset,
  normalizePath,
  type PullRequests,
  pendingRestack,
  projectFiles,
  type RunPlanOptions,
  recordEscalation,
  recordPlan,
  restack,
  restackChildren,
  STACKABLE,
  stallReason,
  unresolvedStack,
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
import { attentionLine } from "./watch.ts";

/** Injection points for tests; production uses OMP, the gh CLI and the configured sandboxes. */
export type Deps = {
  planner?: (input: PlannerInput) => Promise<PlannerResult>;
  worker?: Worker;
  prs?: PullRequests;
  /** The clock and the wait for a rate limit to pass. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** The first answer plus one correction with the gate evidence (SPEC section 2). */
const PLANNER_ATTEMPTS = 2;
/** Empty/aborted/cut-off model calls retried fresh before they count as an attempt. */
const PLANNER_TRANSPORT_RETRIES = 2;
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
  scope: string[];
  covers: string[];
};
export type PlanResult = {
  run_id: string;
  status: "planned" | "escalated" | "failed";
  plan_id?: string;
  tasks?: TaskSummary[];
  escalate?: string[];
  reason?: string;
  planner_attempts: number;
  /** Something the user should know about how the run was set up (e.g. a parent that landed). */
  note?: string;
};

const summary = (plan: Plan): TaskSummary[] =>
  plan.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    kind: t.kind,
    project: t.project,
    lane: t.lane,
    complexity: t.complexity,
    scope: t.scope,
    covers: t.covers,
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
  /** What status and dashboard share: the run's row, units, attempts, usage and stack parent. */
  const snapshot = (runId: string) => {
    const run = runRow(runId);
    return {
      run,
      plan_approved:
        ledger.read({ run_id: runId, types: ["run.plan_ready"] }).length > 0 && approvedPlan(runId),
      units: ledger.units(runId),
      attempts: ledger.attempts(runId),
      usage: ledger.usage(runId),
      ...(run.stack_on
        ? {
            stack_on: {
              run_id: run.stack_on,
              status: ledger.run(run.stack_on)?.status ?? "unknown",
            },
          }
        : {}),
    };
  };
  /** What a run waits on the user for, with the command to go on (see attentionLine); a run that waits on nothing has none. */
  const attention = (runId: string): string | undefined => {
    try {
      const snap = snapshot(runId);
      if (!["planned", "escalated", "paused", "staged"].includes(snap.run.status)) return undefined;
      const events = ledger
        .read({ run_id: runId })
        .map((r) => r.event)
        .map((e) => ({
          id: e.id,
          ts: e.ts,
          type: e.type,
          ...(e.unit_id ? { unit_id: e.unit_id } : {}),
          ...(e.attempt ? { attempt: e.attempt } : {}),
          summary: describe(e),
        }));
      return attentionLine(runId, snap, events);
    } catch {
      return undefined;
    }
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
  const meta = (
    runId: string,
    brief: Brief,
    workspaceRoot: string,
    changesetId: string,
    stackOn?: string,
  ) => ({
    ledger,
    brief,
    runId,
    changesetId,
    workspaceRoot,
    workspaceName: config.workspace.name,
    config: engineConfig,
    gates,
    workspace,
    ...(stackOn ? { stackOn } : {}),
  });
  /**
   * heph new --stack-on: the parent must be a run of this workspace that this node owns, built
   * or staged (design 3.1). One that already landed means a normal run, with a note.
   */
  const stackParent = (parentId: string): { stackOn?: string; note?: string } => {
    const fail = (why: string) => {
      throw new Error(`--stack-on ${parentId}: ${why}`);
    };
    const parent = ledger.run(parentId);
    if (!parent) return fail(`no run ${parentId} on ${config.node.id}`);
    if (parent.owner_node !== config.node.id)
      return fail(`${parentId} is owned by ${parent.owner_node}, not ${config.node.id}`);
    const d = ledger.read({ run_id: parentId, types: ["run.created"] }).at(-1)?.event.data as
      | { workspace_name?: string; workspace_root?: string }
      | undefined;
    const sameWorkspace = d?.workspace_name
      ? d.workspace_name === config.workspace.name
      : d?.workspace_root === opts.workspaceDir;
    if (!sameWorkspace)
      return fail(
        `${parentId} is a run of workspace ${d?.workspace_name ?? d?.workspace_root ?? "?"}, not ${config.workspace.name}`,
      );
    if (parent.status === "finished")
      return { note: `${parentId} already landed; this run starts from the target` };
    if (parent.status === "failed") {
      const reason = (
        ledger.read({ run_id: parentId, types: ["run.failed"] }).at(-1)?.event.data as
          | { reason?: string }
          | undefined
      )?.reason;
      return fail(`${parentId} is failed${reason ? ` (${reason})` : ""}`);
    }
    if (!STACKABLE.has(parent.status))
      return fail(`${parentId} is ${parent.status}; a parent must be built or staged`);
    return { stackOn: parentId };
  };
  /** A stacked run's ancestors; throws when one was revised, paused or cancelled since. */
  const resolvableStack = (runId: string, stackOn?: string) => {
    const ancestors = ancestorsOf(ledger, runId, stackOn);
    const unresolved = unresolvedStack(ancestors);
    if (unresolved) throw new Error(unresolved);
    return ancestors;
  };
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
  /**
   * Once a run landed: restacks its staged children onto the target and retargets their pull
   * requests (design 3.3), each under its own lock. A child that fails is paused on its own; the
   * parent's result is never affected. Nothing to report: undefined.
   */
  const restacked = async (parentId: string) => {
    const out = await restackChildren({
      ledger,
      parentId,
      options: landOptions,
      around: locked,
    });
    const entries = Object.entries(out).map(([id, r]) => [
      id,
      {
        status: r.status,
        ...(r.reason ? { reason: r.reason } : {}),
        ...("prs" in r && r.prs ? { prs: r.prs } : {}),
      },
    ]);
    return entries.length ? { restacked: Object.fromEntries(entries) } : {};
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
    // A stacked run is planned against its ancestors' branches where they have one (design 3.1).
    const ancestors = resolvableStack(runId);
    const refs = await ancestorRefs({ workspace, workspaceRoot, ancestors });
    const files = await projectFiles(workspace, workspaceRoot, refs);
    const route = config.routing.planner?.default ?? config.routing.planner?.standard;
    if (!route) throw new Error("no route for the planner role");
    const m = meta(runId, brief, workspaceRoot, changesetId);
    const base = { run_id: runId, changeset_id: changesetId, config_hash: hash };
    ledger.append({ ...base, actor: "engine", type: "node.started", graph_node: "plan", data: {} });
    let feedback: GateResult[] | undefined;
    let previousOutput: string | undefined;
    let tries = 0;
    let transports = 0;
    let lastTransport: string | undefined;
    for (let attempt = 1; tries < PLANNER_ATTEMPTS; attempt++) {
      const r = await planner({
        brief,
        workspace,
        projectGates,
        files,
        repoMap: await (async () => {
          const w = await workers();
          return w.repoMapFromFiles(files, {
            brief: w.textOf(brief),
            focus: feedback ? w.pathsInEvidence(feedback) : [],
          });
        })(),
        route,
        ...extra,
        ...(feedback ? { feedback, ...(previousOutput ? { previousOutput } : {}) } : {}),
      });
      const ev = r.evaluation;
      const answer = (outcome: "valid" | "invalid" | "escalated", failures: string[]) =>
        ledger.append({
          ...base,
          actor: "engine",
          type: "plan.answer",
          graph_node: "plan",
          data: { attempt, outcome, failures },
          // The raw answer and transcript, so a bad answer can be diagnosed afterwards.
          blobs: {
            log: ledger.blobs.put(r.output),
            ...(r.transcript ? { transcript: ledger.blobs.put(r.transcript) } : {}),
          },
        });
      const done = (outcome: string) =>
        ledger.append({
          ...base,
          actor: "engine",
          type: "node.finished",
          graph_node: "plan",
          data: { outcome },
        });
      if (ev.escalate) {
        answer("escalated", []);
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
        answer("valid", []);
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
      answer("invalid", ev.failures);
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
      if (r.transport) {
        // The model call failed (empty, aborted, cut off): nothing to correct, so ask again
        // fresh with the same prompt. Bounded, so a dead provider still ends the run.
        lastTransport = r.transport;
        if (++transports > PLANNER_TRANSPORT_RETRIES) tries++;
        continue;
      }
      tries++;
      feedback = failed;
      previousOutput = r.output;
    }
    const reason = lastTransport
      ? `the planner produced no valid plan in ${PLANNER_ATTEMPTS} attempts (${lastTransport})`
      : `the planner produced no valid plan in ${PLANNER_ATTEMPTS} attempts`;
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

    async newRun(
      briefInput: unknown,
      o: { runId?: string; stackOn?: string } = {},
    ): Promise<PlanResult> {
      const brief = Brief.parse(briefInput);
      const gate = briefGate(brief, workspace, projectGates);
      if (gate.verdict === "fail") throw new Error(`brief gate: ${gate.evidence.join("; ")}`);
      const stack = o.stackOn ? stackParent(o.stackOn) : {};
      const runId = o.runId ?? newRunId();
      if (ledger.run(runId)) throw new Error(`run ${runId} already exists`);
      if (stack.stackOn) resolvableStack(runId, stack.stackOn);
      createRun(meta(runId, brief, opts.workspaceDir, runId, stack.stackOn));
      const result = await plan(runId, brief, opts.workspaceDir, runId);
      return stack.note ? { ...result, note: stack.note } : result;
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
        resolvableStack(runId);
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
      if (!runId)
        return {
          runs: ledger.runs().map((r) => {
            const needs = attention(r.run_id);
            return needs ? { ...r, needs_you: needs } : r;
          }),
        };
      const staged = ledger.read({ run_id: runId, types: ["merge.staged"] }).at(-1)?.event.data as
        | { prs?: Record<string, string> }
        | undefined;
      return { ...snapshot(runId), ...(staged?.prs ? { prs: staged.prs } : {}) };
    },

    /** Everything the run page shows, in one read (a superset of status without the prs). */
    dashboard(runId: string) {
      const snap = snapshot(runId);
      const planned = ledger.read({ run_id: runId, types: ["run.plan_ready"] }).length > 0;
      const tasks = planned ? latestPlan(runId).plan.tasks : [];
      const needs = new Map<string, string[]>();
      for (const e of deriveEdges(tasks).edges) {
        const list = needs.get(e.to) ?? [];
        if (!list.includes(e.from)) list.push(e.from);
        needs.set(e.to, list);
      }
      const inPlan = new Set(tasks.map((t) => t.id));
      const gates = new Map<string, GateResult[]>();
      for (const { event: e } of ledger.read({ run_id: runId, types: ["gate.result"] })) {
        if (!e.unit_id || e.attempt === undefined) continue;
        const key = `${e.unit_id}#${e.attempt}`;
        gates.set(key, [...(gates.get(key) ?? []), e.data as GateResult]);
      }
      const marks = ledger
        .read({ run_id: runId, types: ["run.paused", "run.resumed"] })
        .map((s) => s.event);
      const lastResume = marks.findLastIndex((e) => e.type === "run.resumed");
      const pauses = marks
        .slice(lastResume + 1)
        .filter((e) => e.type === "run.paused")
        .map((e) => (e.data as { reason: string }).reason);
      return {
        schema: 1 as const,
        run: snap.run,
        plan_approved: snap.plan_approved,
        plan: {
          units: tasks.map((t) => ({
            id: t.id,
            title: t.title,
            kind: t.kind,
            project: t.project,
            depends_on: needs.get(t.id) ?? [],
          })),
        },
        units: [
          ...snap.units.map((u) => ({
            unit_id: u.unit_id,
            status: u.status,
            attempts: u.attempts,
            in_plan: inPlan.has(u.unit_id),
          })),
          // A revision resets the units to the new plan; what an earlier plan's units did stays
          // in their attempts, so those show as dropped.
          ...[...new Set(snap.attempts.map((a) => a.unit_id))]
            .filter((id) => !snap.units.some((u) => u.unit_id === id))
            .map((id) => ({
              unit_id: id,
              status: "dropped",
              attempts: snap.attempts.filter((a) => a.unit_id === id).length,
              in_plan: false,
            })),
        ],
        attempts: snap.attempts.map((a) => ({
          unit_id: a.unit_id,
          attempt: a.attempt,
          status: a.status,
          ...(a.model ? { model: a.model } : {}),
          ...(a.provider ? { provider: a.provider } : {}),
          ...(a.outcome ? { outcome: a.outcome } : {}),
          ...(a.duration_ms !== null ? { duration_ms: a.duration_ms } : {}),
          gates: gates.get(`${a.unit_id}#${a.attempt}`) ?? [],
        })),
        pauses,
        ...(snap.stack_on ? { stack_on: snap.stack_on } : {}),
        usage: snap.usage,
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
      // Units that stopped the build (escalated or stalled) and are not accepted since.
      const stuck = new Map<string, boolean>();
      for (const e of ledger.read({ run_id: runId, ...(unit ? { unit_id: unit } : {}) })) {
        const u = e.event.unit_id;
        if (!u) continue;
        if (e.event.type === "unit.escalated" || e.event.type === "unit.stalled")
          stuck.set(u, true);
        else if (e.event.type === "unit.accepted") stuck.delete(u);
      }
      const all = ledger.read({ run_id: runId }).map((s) => s.event) as unknown as LedgerEvent[];
      const blob = (id: string) => ledger.blobs.getText(id);
      const diagnoses = [...stuck.keys()].flatMap((u) => diagnose(all, u, blob) ?? []);
      return {
        run_id: runId,
        ...(unit ? { unit } : {}),
        events,
        ...(diagnoses.length ? { diagnoses } : {}),
      };
    },

    /**
     * heph hint: guidance for a unit, a bigger token budget, and files it may change beyond its
     * planned scope (project-relative; the project's own repo-relative paths are accepted).
     */
    hint(
      runId: string,
      unit: string,
      text: string,
      more: number | { budget?: number; scope?: string[] } = {},
    ) {
      const o = typeof more === "number" ? { budget: more } : more;
      const budget = o.budget;
      const row = runRow(runId);
      if (TERMINAL.has(row.status)) throw new Error(`run ${runId} is ${row.status}`);
      const { plan: p } = latestPlan(runId);
      const task = p.tasks.find((t) => t.id === unit);
      if (!task) throw new Error(`run ${runId} has no unit ${unit}`);
      if (!text && !budget && !o.scope?.length)
        throw new Error("say something: a hint text, --scope or --budget");
      const projectPath = workspace.projects[task.project]?.path ?? ".";
      const prefix = projectPath === "." ? "" : `${normalizePath(projectPath)}/`;
      const scope = (o.scope ?? []).map((raw) => {
        let s = normalizePath(raw.trim());
        if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
        if (
          !s ||
          s === "." ||
          s.startsWith("/") ||
          s.split("/").includes("..") ||
          /^\*\*(\/\*)?$/.test(s)
        )
          throw new Error(
            `--scope ${raw}: give files or a glob inside project ${task.project}, relative to it`,
          );
        return s;
      });
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
      if (scope.length) {
        human(runId, c.changesetId, {
          type: "human.input",
          unit_id: unit,
          data: { kind: "scope", scope },
        });
        recorded.push("scope");
      }
      return { run_id: runId, unit, recorded, ...(scope.length ? { scope } : {}) };
    },

    async cancel(runId: string) {
      const row = runRow(runId);
      if (TERMINAL.has(row.status)) throw new Error(`run ${runId} is already ${row.status}`);
      const c = created(runId);
      human(runId, c.changesetId, {
        type: "run.failed",
        data: { reason: "cancelled by user" },
      });
      // A cancelled run never resumes, so join pins a killed build left would stay forever. A
      // process still driving the run holds its lock and is left alone: none of its pins outlive
      // its joins.
      let release: (() => void) | undefined;
      try {
        release = lockRun(opts.home, runId);
      } catch {}
      if (release) {
        try {
          await dropJoinPins({ workspace, workspaceRoot: c.workspaceRoot, runId });
        } finally {
          release();
        }
      }
      return { run_id: runId, status: "failed" as const };
    },

    async approveMerge(runId: string) {
      const notStaged = (status: string) =>
        new Error(`run ${runId} is ${status}, not staged (heph run ${runId} first)`);
      const row = runRow(runId);
      if (row.status !== "staged") throw notStaged(row.status);
      const approval = human(runId, created(runId).changesetId, {
        type: "human.input",
        data: { kind: "approve", target: "merge" },
      });
      return locked(runId, async () => {
        const now = runRow(runId).status;
        if (now !== "staged") throw notStaged(now);
        // A stacked run staged before its parent landed (the ledger says so, whatever its PR's
        // base now is), or whose retarget never finished: restacked now, not merged. Its code
        // moved, so merging is a fresh approval.
        const onto = await pendingRestack(landOptions(runId));
        if (Object.keys(onto).length) {
          const out = await restack(landOptions(runId));
          return {
            run_id: runId,
            result:
              out.status === "staged"
                ? { status: "restacked" as const, onto, ...(out.prs ? { prs: out.prs } : {}) }
                : { status: "aborted" as const, reason: out.reason ?? "restack failed" },
          };
        }
        // Restacked by someone else (heph merge status of its parent) after this approval was
        // recorded: what would merge is not what was approved, so it waits for a fresh one.
        const staged = ledger.read({ run_id: runId, types: ["merge.staged"] }).at(-1)?.event;
        if (staged && staged.id > approval.id) {
          const d = staged.data as { refs: Record<string, string>; prs?: Record<string, string> };
          return {
            run_id: runId,
            result: {
              status: "restacked" as const,
              onto: Object.fromEntries(Object.keys(d.refs).map((r) => [r, targets?.[r] ?? "main"])),
              ...(d.prs ? { prs: d.prs } : {}),
            },
          };
        }
        const result = await mergeChangeset(landOptions(runId));
        return {
          run_id: runId,
          result,
          ...(result.status === "merged" ? await restacked(runId) : {}),
        };
      });
    },

    async mergeStatus(runId: string) {
      runRow(runId);
      const result = await checkChangeset(landOptions(runId));
      return {
        run_id: runId,
        result,
        ...(result.status === "merged" ? await restacked(runId) : {}),
      };
    },
  };
}

function toEngineConfig(config: ResolvedConfig): EngineConfig {
  return {
    routing: config.routing,
    maxAttempts: config.limits.attempts_per_unit,
    budgetTokens: config.limits.budget_tokens,
    gateTimeoutMs: config.limits.gate_timeout_ms,
    attemptTimeoutMs: config.limits.attempt_timeout_ms,
    idleTimeoutMs: config.limits.idle_timeout_ms,
    transportRetries: config.limits.transport_retries,
    ...(config.limits.attempt_timeout_ms_by_tier
      ? { attemptTimeoutByTier: config.limits.attempt_timeout_ms_by_tier }
      : {}),
    parallel: config.limits.parallel,
    tools: [],
    commands: Object.fromEntries(Object.entries(config.projects).map(([p, s]) => [p, s.commands])),
  };
}

const LOG_CAPTURED_LINES = 6;
const LOG_LINE_CHARS = 200;
const LOG_TEXT_CHARS = 240;

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n)}... (truncated, ${s.length - n} more chars)` : s;

/**
 * An event for the daemon log: Heph's own words on the first line, and what a command printed
 * (a project's test output can be pages of it) only as a bounded, `  | `-prefixed tail. The
 * whole event stays in the ledger: `heph explain <run> <unit>` shows it.
 */
export function describeForLog(
  e: { type: string; data: unknown; unit_id?: string; attempt?: number | undefined },
  runId: string,
): string {
  const d = e.data as Record<string, unknown>;
  if (e.type === "gate.result") {
    const g = d as unknown as GateResult;
    const [exit, ...rest] = g.evidence;
    const head = `${g.gate} ${g.verdict}: ${clip(g.reason, LOG_TEXT_CHARS)}${exit ? ` (${clip(exit, 60)})` : ""}`;
    const out = rest.join("\n").replace(/\n+$/, "");
    if (!out || g.verdict === "pass") return head;
    const all = out.split("\n");
    const shown = all.slice(-LOG_CAPTURED_LINES);
    const hidden = all.length - shown.length;
    const where = `heph explain ${runId}${e.unit_id ? ` ${e.unit_id}` : ""}`;
    return [
      head,
      ...shown.map((l) => `  | ${clip(l, LOG_LINE_CHARS)}`),
      `  (${hidden ? `${hidden} earlier lines not shown; ` : ""}full evidence in the ledger: ${where})`,
    ].join("\n");
  }
  return clip(describe(e), LOG_TEXT_CHARS).replace(/\n/g, " ");
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
    case "unit.stalled": {
      const [a, b] = d.attempts as [number, number];
      const failing = d.failing as { gate: string; evidence?: string }[];
      const gates = [...new Set(failing.map((f) => f.gate))];
      return stallReason(gates.join(", "), [a, b], failing[0]?.evidence);
    }
    case "run.plan_ready":
      return `plan ready: ${((d.plan as Plan).tasks ?? []).map((t) => t.id).join(", ")}`;
    case "run.plan_escalated":
      return `escalated: ${(d.reasons as string[]).join("; ")}`;
    case "human.input":
      return `${d.kind}${d.target ? ` ${d.target}` : ""}${d.text ? `: ${d.text}` : ""}${d.budget_tokens ? ` (${d.budget_tokens} tokens)` : ""}${Array.isArray(d.scope) ? `: may also change ${d.scope.join(", ")}` : ""}`;
    case "effect.intended":
      // A retarget's `after` is a branch, shown whole; elsewhere it is a sha.
      return `${String(d.effect).replaceAll("_", " ")}: ${d.target}${d.after ? ` to ${d.effect === "pr_retarget" ? d.after : String(d.after).slice(0, 7)}` : ""}`;
    case "effect.done":
      return `${String(d.effect).replaceAll("_", " ")} ${d.state}${d.sha ? ` (${String(d.sha).slice(0, 7)})` : ""}${d.url ? ` ${d.url}` : ""}`;
    case "run.created":
      return typeof d.stack_on === "string"
        ? `run created, stacked on ${d.stack_on}`
        : "run created";
    case "run.handed_off":
      return `handed off to ${d.to}`;
    case "run.paused":
      return d.reason === "user" ? "run paused: waiting for you" : `run paused: ${d.reason}`;
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
