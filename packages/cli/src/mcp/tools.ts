// The tools a chat host sees. One-call tools go through toolResult (daemon call, schema check, text + structured answer); heph_run and heph_watch compose several calls through the same guarded client.

import { resolve } from "node:path";
import { Brief } from "@hephaestus/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Dashboard, Explain, OUTPUT, StatusOne } from "../output.ts";
import { readTrustedUiFile } from "../ui-server.ts";
import type { WatchView } from "../watch.ts";
import { PLAN_HTML, RUN_HTML } from "./app/generated.ts";
import type { AllowedMethod } from "./guard.ts";
import type { McpCtx } from "./server.ts";
import {
  cancelText,
  explainText,
  hintText,
  planResultText,
  planShowText,
  runText,
  statusText,
  watchText,
} from "./text.ts";
import { abortError, boundedBy, type Outcome, StepDeadlineError, watchStep } from "./watch.ts";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  /** For the widget only: hosts do not show it to the model. */
  _meta?: Record<string, unknown>;
  isError?: true;
};

/** Where the widgets may read the daemon's read-only dashboard, when one is running. */
function dashboardOrigin(ctx: McpCtx): { origin: string; token: string } | undefined {
  const ui = ctx.home === undefined ? undefined : readTrustedUiFile(ctx.home);
  return ui ? { origin: `http://127.0.0.1:${ui.port}`, token: ui.token } : undefined;
}

/**
 * Adds the dashboard origin and token to a result's `_meta`, which only the widget sees, so the
 * widget can poll the dashboard itself. Never in the text or structuredContent the model reads.
 */
function withLive(ctx: McpCtx, r: ToolResult): ToolResult {
  const live = r.isError ? undefined : dashboardOrigin(ctx);
  return live ? { ...r, _meta: { ...r._meta, heph: { live } } } : r;
}

const failure = (text: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Runs one daemon call, checks its answer against OUTPUT[command], and renders it.
 * Any failure (no daemon, a daemon error, a drifted payload) becomes an isError result.
 */
export async function toolResult<C extends keyof typeof OUTPUT>(
  ctx: McpCtx,
  call: { method: AllowedMethod; args: unknown[]; command: C; cwd?: string },
  render: (data: z.infer<(typeof OUTPUT)[C]>) => string,
): Promise<ToolResult> {
  let raw: unknown;
  try {
    raw = await ctx.client.call(call.method, call.args, call.cwd ?? ctx.workspace());
  } catch (e) {
    return failure(errorText(e));
  }
  const parsed = OUTPUT[call.command].safeParse(raw);
  if (!parsed.success)
    return failure(`unexpected daemon answer for ${call.command}: ${parsed.error.message}`);
  const data = parsed.data as z.infer<(typeof OUTPUT)[C]>;
  return {
    content: [{ type: "text", text: render(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

const OUTCOMES = [
  "running",
  "awaiting_plan_approval",
  "waiting_for_you",
  "planner_escalated",
  "waiting_for_parent",
  "blocked_by_parent",
  "staged",
  "finished",
  "failed",
] as const satisfies readonly Outcome[];
// Every outcome watchStep can give is in the enum, or structured output would reject that stop.
const _everyOutcome: [Exclude<Outcome, (typeof OUTCOMES)[number]>] extends [never] ? true : false =
  true;
const RunToolResult = z
  .object({
    run_id: z.string(),
    state: z.enum(["awaiting_plan_approval", "started", "already_running", "not_runnable"]),
    status: z.string(),
    lines: z.array(z.string()),
    cursor: z.string().min(1).optional(),
    outcome: z.enum(OUTCOMES).optional(),
    waiting_for: z.string().min(1).optional(),
    blocked: z.string().min(1).optional(),
    // The run widget's view (heph_status's answer and its graph), added best effort.
    run: z.unknown().optional(),
    plan_approved: z.unknown().optional(),
    units: z.unknown().optional(),
    attempts: z.unknown().optional(),
    usage: z.unknown().optional(),
    prs: z.unknown().optional(),
    stack_on: z.unknown().optional(),
    stale: z.unknown().optional(),
    graph: z.unknown().optional(),
  })
  .strict();
const WatchToolResult = z
  .object({
    run_id: z.string(),
    status: z.string(),
    lines: z.array(z.string()),
    cursor: z.string().min(1).optional(),
    outcome: z.enum(OUTCOMES),
    waiting_for: z.string().min(1).optional(),
    blocked: z.string().min(1).optional(),
    // The run widget's view (heph_status's answer and its graph), added best effort.
    run: z.unknown().optional(),
    plan_approved: z.unknown().optional(),
    units: z.unknown().optional(),
    attempts: z.unknown().optional(),
    usage: z.unknown().optional(),
    prs: z.unknown().optional(),
    stack_on: z.unknown().optional(),
    stale: z.unknown().optional(),
    graph: z.unknown().optional(),
  })
  .strict();
/** What the daemon's `run` answers: a build job started on it, or one already going. */
const RunStarted = z
  .object({
    run_id: z.string(),
    started: z.boolean(),
    running: z.boolean().optional(),
    after: z.string().min(1).optional(),
  })
  .strict();

/** A long poll waits at most this long, under common host tool-call timeouts. */
const MAX_WAIT_S = 25;
const DEFAULT_WAIT_S = 20;
/**
 * Transient daemon errors (no daemon, a timeout, a dropped socket) retried within one step, 2 s
 * apart: enough to ride out a daemon restart. An error the daemon answers (an unknown run) is not
 * retried. watchStep also stops retrying one interval past the step's wait (so heph_run, wait 0,
 * retries once), and the step's overall bound (wait + 15 s; heph_run's 30 s) caps them all.
 */
const STEP_RETRIES = 8;
/** Run statuses `run` would only reject after already answering `started` (runtime.ts build). */
const NOT_RUNNABLE = new Set(["failed", "finished", "staged", "escalated"]);
/**
 * Statuses whose unapproved plan waits for the user. `run` on a paused or built run would answer
 * `started` before the build refuses the unapproved plan, so heph_run does not call it.
 */
const AWAITS_APPROVAL = new Set(["planned", "paused", "built"]);

/**
 * heph_run's whole budget: its status read, `run` and first progress read together. Each call is
 * bounded at 10 s by the guard, and this keeps the sum under common host tool timeouts.
 */
const RUN_BUDGET_MS = 30_000;
/** A `run` cut off by the budget may still have started the build. */
const RUN_DEADLINE_HINT =
  "check the run with heph_status; calling heph_run again is safe (a build that did start answers already_running)";

/** status and explain through the guarded client, checked against the CLI's schemas. */
function daemonView(ctx: McpCtx, signal?: AbortSignal): WatchView {
  const cwd = () => ctx.workspace();
  const opts = (s?: AbortSignal) => {
    const sig = s ?? signal;
    return sig ? { signal: sig } : undefined;
  };
  return {
    status: async (id, s) => StatusOne.parse(await ctx.client.call("status", [id], cwd(), opts(s))),
    explain: async (id, s) => Explain.parse(await ctx.client.call("explain", [id], cwd(), opts(s))),
  };
}

/** What the run widget draws beyond status: the plan's units with their dependencies, and every attempt's gates. */
async function runGraph(ctx: McpCtx, run: string) {
  try {
    const d = Dashboard.parse(await ctx.client.call("dashboard", [run], ctx.workspace()));
    return { units: d.plan.units, attempts: d.attempts, pauses: d.pauses };
  } catch {
    return undefined;
  }
}

/** The run widget's whole view of one run: status plus graph; undefined when the daemon will not say. */
async function runView(ctx: McpCtx, run: string): Promise<Record<string, unknown> | undefined> {
  try {
    const [status, graph] = await Promise.all([
      ctx.client.call("status", [run], ctx.workspace()),
      runGraph(ctx, run),
    ]);
    const parsed = StatusOne.safeParse(status);
    if (!parsed.success) return undefined;
    return { ...parsed.data, ...(graph ? { graph } : {}) };
  } catch {
    return undefined;
  }
}

const withoutUndefined = <T extends Record<string, unknown>>(o: T): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const { $schema: _dialect, ...briefJsonSchema } = z.toJSONSchema(Brief) as Record<string, unknown>;
// Built from the real schema, so what the model is told cannot drift from what heph_new accepts.
const PLAN_URI = "ui://heph/plan";
const RUN_URI = "ui://heph/run";
const APP_MIME = "text/html;profile=mcp-app";

const BRIEF_DESCRIPTION = `A complete Brief object (strict: no extra keys; every list field is required except known_paths, but the brief gate rejects an empty acceptance, any open_questions left unresolved, duplicate criterion ids, a check gate not configured in any project, known_paths projects not in the workspace, and a criterion whose projects names a project not in the workspace, lists one twice, or also sets check). JSON Schema: ${JSON.stringify(briefJsonSchema)}`;

export function registerTools(server: McpServer, ctx: McpCtx): void {
  server.registerResource(
    "plan-widget",
    PLAN_URI,
    { mimeType: APP_MIME, description: "The plan review widget (an MCP App)" },
    async () => ({ contents: [{ uri: PLAN_URI, mimeType: APP_MIME, text: PLAN_HTML }] }),
  );
  server.registerResource(
    "run-widget",
    RUN_URI,
    { mimeType: APP_MIME, description: "The run view widget (an MCP App)" },
    async () => {
      // The widget may connect to the dashboard and nowhere else; the origin is read at each
      // read because the daemon may have picked another port since the server started.
      const live = dashboardOrigin(ctx);
      return {
        contents: [
          {
            uri: RUN_URI,
            mimeType: APP_MIME,
            text: RUN_HTML,
            ...(live ? { _meta: { ui: { csp: { connectDomains: [live.origin] } } } } : {}),
          },
        ],
      };
    },
  );
  server.registerTool(
    "heph_plan_show",
    {
      description:
        "Show a heph run's plan: its tasks, build order and risks, and whether the user has approved it.",
      inputSchema: { run: z.string().min(1).describe("The run id, e.g. r1") },
      // Hosts that render MCP Apps show the plan as a widget; the rest see the text result.
      _meta: { ui: { resourceUri: PLAN_URI }, "ui/resourceUri": PLAN_URI },
    },
    ({ run }) =>
      toolResult(ctx, { method: "planShow", args: [run], command: "plan show" }, planShowText),
  );

  server.registerTool(
    "heph_status",
    {
      description:
        "List heph runs, or show one run: its units, attempts, model usage and pull requests. The list marks every run that waits on the user with `needs you:` and the command to go on, so one call answers whether anything is blocked.",
      inputSchema: {
        run: z.string().min(1).optional().describe("A run id; omit to list every run"),
      },
      // Hosts that render MCP Apps show the run as a widget; the rest see the text result.
      _meta: { ui: { resourceUri: RUN_URI }, "ui/resourceUri": RUN_URI },
    },
    async ({ run }) => {
      if (run === undefined)
        return withLive(
          ctx,
          await toolResult(ctx, { method: "status", args: [], command: "status" }, statusText),
        );
      // The widget's graph needs unit titles and dependencies, which status does not carry: one
      // more read-only call, whose failure costs the widget its graph and nothing else.
      const [result, graph] = await Promise.all([
        toolResult(ctx, { method: "status", args: [run], command: "status" }, statusText),
        runGraph(ctx, run),
      ]);
      if (result.isError || !graph || !result.structuredContent) return withLive(ctx, result);
      return withLive(ctx, {
        ...result,
        structuredContent: { ...result.structuredContent, graph },
      });
    },
  );

  server.registerTool(
    "heph_explain",
    {
      description: "What happened in a heph run, one line per event; optionally for one unit.",
      inputSchema: {
        run: z.string().min(1).describe("The run id, e.g. r1"),
        unit: z.string().min(1).optional().describe("Limit the events to this unit id"),
      },
    },
    ({ run, unit }) =>
      toolResult(
        ctx,
        { method: "explain", args: unit === undefined ? [run] : [run, unit], command: "explain" },
        explainText,
      ),
  );

  server.registerTool(
    "heph_new",
    {
      description:
        "Plan a new heph run from a Brief. The plan waits for the user's approval; show it to them and let them approve it themselves.",
      inputSchema: {
        brief: z.unknown().describe(BRIEF_DESCRIPTION),
        workspace: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Directory of the heph workspace; needed when the server was not started in one",
          ),
        on: z.string().min(1).optional().describe('Node to run on; "local" keeps the run here'),
      },
      // The run widget shows the new run from the first moment.
      _meta: { ui: { resourceUri: RUN_URI }, "ui/resourceUri": RUN_URI },
    },
    async ({ brief, workspace, on }) => {
      if (typeof brief !== "object" || brief === null || Array.isArray(brief))
        return failure("brief must be an object");
      const parsed = Brief.safeParse(brief);
      if (!parsed.success)
        return failure(
          `invalid brief:\n${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(brief)"}: ${i.message}`)
            .join("\n")}`,
        );
      const serverCwd = ctx.cwd ?? process.cwd();
      const cwd = workspace !== undefined ? resolve(serverCwd, workspace) : ctx.workspace();
      if (!cwd)
        return failure(
          `no heph workspace directory: none found from ${serverCwd}, where the server was started, so pass the workspace argument (the directory that holds .heph/)`,
        );
      const made = await toolResult(
        ctx,
        {
          method: "newRun",
          args: [parsed.data, on === undefined ? {} : { on }],
          command: "new",
          cwd,
        },
        planResultText,
      );
      const id = made.structuredContent?.run_id;
      const view = !made.isError && typeof id === "string" ? await runView(ctx, id) : undefined;
      return withLive(
        ctx,
        view && made.structuredContent
          ? { ...made, structuredContent: { ...made.structuredContent, ...view } }
          : made,
      );
    },
  );

  server.registerTool(
    "heph_plan_revise",
    {
      description:
        "Plan a run again with the user's feedback. The revised plan needs the user's approval again.",
      inputSchema: {
        run: z.string().min(1).describe("The run id, e.g. r1"),
        instructions: z.string().min(1).describe("What to change about the plan"),
      },
    },
    ({ run, instructions }) =>
      toolResult(
        ctx,
        { method: "revise", args: [run, instructions], command: "plan revise" },
        planResultText,
      ),
  );

  server.registerTool(
    "heph_hint",
    {
      description:
        "Guide a unit that escalated; scope lets it change more files. The user then runs the run again.",
      inputSchema: {
        run: z.string().min(1).describe("The run id, e.g. r1"),
        unit: z.string().min(1).describe("The unit id"),
        text: z.string().min(1).describe("The guidance"),
        scope: z
          .array(z.string().min(1))
          .optional()
          .describe("Extra project-relative paths it may change"),
        budget: z.number().int().positive().optional().describe("Token budget for the unit"),
      },
    },
    ({ run, unit, text, scope, budget }) =>
      toolResult(
        ctx,
        {
          method: "hint",
          args: [
            run,
            unit,
            text,
            { ...(scope?.length ? { scope } : {}), ...(budget ? { budget } : {}) },
          ],
          command: "hint",
        },
        hintText,
      ),
  );

  server.registerTool(
    "heph_cancel",
    {
      description: "Stop a heph run for good. It cannot be resumed.",
      inputSchema: { run: z.string().min(1).describe("The run id, e.g. r1") },
    },
    ({ run }) => toolResult(ctx, { method: "cancel", args: [run], command: "cancel" }, cancelText),
  );

  server.registerTool(
    "heph_run",
    {
      description:
        "Start building a run whose plan the user has approved, and return its first progress lines. If the plan is not approved it does not start; ask the user to approve it themselves. A staged, finished, failed or escalated run, or one with no plan yet, is not started (state not_runnable); do what next says. Follow a started build with heph_watch.",
      inputSchema: { run: z.string().min(1).describe("The run id, e.g. r1") },
      outputSchema: RunToolResult.shape,
      // Dispatching a run opens the run widget, which then follows it.
      _meta: { ui: { resourceUri: RUN_URI }, "ui/resourceUri": RUN_URI },
    },
    async ({ run }, extra) => {
      // One budget for the whole call: a hung daemon is an error before the host gives up.
      const budget = ctx.runBudgetMs ?? RUN_BUDGET_MS;
      const now = ctx.now ?? Date.now;
      const t0 = now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new StepDeadlineError(RUN_DEADLINE_HINT)), budget);
      const onCancel = () => ac.abort(abortError(extra.signal));
      if (extra.signal.aborted) onCancel();
      else extra.signal.addEventListener("abort", onCancel, { once: true });
      try {
        return withLive(
          ctx,
          await runTool(run, ac.signal, () => Math.max(0, budget - (now() - t0))),
        );
      } finally {
        clearTimeout(timer);
        extra.signal.removeEventListener("abort", onCancel);
      }
    },
  );

  async function runTool(
    run: string,
    signal: AbortSignal,
    remaining: () => number,
  ): Promise<ToolResult> {
    const view = daemonView(ctx, signal);
    let s: Awaited<ReturnType<WatchView["status"]>>;
    try {
      s = await boundedBy(view.status(run), signal);
    } catch (e) {
      return failure(errorText(e));
    }
    if (AWAITS_APPROVAL.has(s.run.status) && !s.plan_approved) {
      const r = {
        run_id: run,
        state: "awaiting_plan_approval" as const,
        status: s.run.status,
        lines: [],
      };
      return { content: [{ type: "text", text: runText(r) }], structuredContent: r };
    }
    const step = (since: string | undefined) =>
      watchStep(run, view, {
        since,
        waitMs: 0,
        retries: STEP_RETRIES,
        sleep: ctx.sleep,
        now: ctx.now,
        signal,
        graceMs: remaining(),
        onDeadline: RUN_DEADLINE_HINT,
      });
    const answer = async (
      state: "started" | "already_running" | "not_runnable",
      w: Awaited<ReturnType<typeof watchStep>>,
    ): Promise<ToolResult> => {
      const r = {
        run_id: run,
        state,
        status: w.status,
        lines: w.lines,
        cursor: w.cursor,
        outcome: w.outcome,
        waiting_for: w.waiting_for,
        blocked: w.blocked,
      };
      const view = await runView(ctx, run);
      return {
        content: [{ type: "text", text: runText(r) }],
        structuredContent: { ...withoutUndefined(r), ...(view ?? {}) },
      };
    };
    // `run` answers `started` before the build rejects these, so they are refused here. Only a
    // running run resumes through `run` whatever its approval flag says.
    if (NOT_RUNNABLE.has(s.run.status) || !(s.plan_approved || s.run.status === "running")) {
      // The daemon would answer `started` and only then fail the build: say where it stands.
      try {
        return await answer("not_runnable", await step(undefined));
      } catch (e) {
        return failure(errorText(e));
      }
    }
    let started: z.infer<typeof RunStarted>;
    try {
      const raw = await boundedBy(
        ctx.client.call("run", [run, {}], ctx.workspace(), { signal }),
        signal,
      );
      const parsed = RunStarted.safeParse(raw);
      if (!parsed.success)
        return failure(`unexpected daemon answer for run: ${parsed.error.message}`);
      started = parsed.data;
    } catch (e) {
      return failure(errorText(e));
    }
    if (!started.started && !started.running)
      return failure(`the daemon did not start ${run} and it is not running`);
    try {
      return await answer(
        started.started ? "started" : "already_running",
        await step(started.after),
      );
    } catch (e) {
      return failure(errorText(e));
    }
  }

  server.registerTool(
    "heph_watch",
    {
      description: `Wait up to wait_s seconds (default ${DEFAULT_WAIT_S}, at most ${MAX_WAIT_S}) for a run's next milestones and say what it needs. Pass the returned cursor as since on the next call; omit since the first time to catch up. When no cursor is returned, call again with since omitted, but not in a tight loop. Outcomes: running (call again); awaiting_plan_approval; waiting_for_you (paused for the user, e.g. a stalled unit); planner_escalated; waiting_for_parent (a stacked run staged behind a parent that has not merged; waiting_for names it); blocked_by_parent (a stacked run whose parent failed or was cancelled; it needs a rebuild); staged; finished; failed. Stop watching when the outcome is not running and do what next says; approvals are always the user's.`,
      inputSchema: {
        run: z.string().min(1).describe("The run id, e.g. r1"),
        since: z
          .string()
          .min(1)
          .optional()
          .describe("The cursor from the previous heph_watch or heph_run; omit to catch up"),
        wait_s: z
          .number()
          .optional()
          .describe(`Seconds to wait for news, 0 to ${MAX_WAIT_S}; default ${DEFAULT_WAIT_S}`),
      },
      outputSchema: WatchToolResult.shape,
      // Each return carries the run's current view, so a host that renders MCP Apps redraws the widget.
      _meta: { ui: { resourceUri: RUN_URI }, "ui/resourceUri": RUN_URI },
    },
    async ({ run, since, wait_s }, extra) => {
      const waitS = Math.min(MAX_WAIT_S, Math.max(0, wait_s ?? DEFAULT_WAIT_S));
      const token = extra._meta?.progressToken;
      const sent: Promise<void>[] = [];
      let progress = 0;
      try {
        const w = await watchStep(run, daemonView(ctx), {
          since,
          waitMs: waitS * 1000,
          retries: STEP_RETRIES,
          sleep: ctx.sleep,
          now: ctx.now,
          ...(ctx.graceMs === undefined ? {} : { graceMs: ctx.graceMs }),
          onDeadline: "call heph_watch again",
          // A cancelled request stops polling; the SDK drops whatever the tool returns then.
          signal: extra.signal,
          ...(token === undefined
            ? {}
            : {
                onLine: (line: string) => {
                  // A progress line is best effort: a host that went away must not fail the watch.
                  sent.push(
                    extra
                      .sendNotification({
                        method: "notifications/progress",
                        params: { progressToken: token, progress: ++progress, message: line },
                      })
                      .catch(() => {}),
                  );
                },
              }),
        });
        await Promise.all(sent);
        const view = await runView(ctx, run);
        return withLive(ctx, {
          content: [{ type: "text", text: watchText(w) }],
          structuredContent: { ...withoutUndefined(w), ...(view ?? {}) },
        });
      } catch (e) {
        await Promise.all(sent);
        return failure(errorText(e));
      }
    },
  );
}
