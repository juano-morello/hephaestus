// The tools a chat host sees. One-call tools go through toolResult (daemon call, schema check, text + structured answer); heph_run and heph_watch compose several calls through the same guarded client.

import { resolve } from "node:path";
import { Brief } from "@hephaestus/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Explain, OUTPUT, StatusOne } from "../output.ts";
import type { WatchView } from "../watch.ts";
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
import { type Outcome, watchStep } from "./watch.ts";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: true;
};

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
    cursor: z.string().optional(),
    outcome: z.enum(OUTCOMES).optional(),
    waiting_for: z.string().optional(),
    blocked: z.string().optional(),
  })
  .strict();
const WatchToolResult = z
  .object({
    run_id: z.string(),
    status: z.string(),
    lines: z.array(z.string()),
    cursor: z.string().optional(),
    outcome: z.enum(OUTCOMES),
    waiting_for: z.string().optional(),
    blocked: z.string().optional(),
  })
  .strict();
/** What the daemon's `run` answers: a build job started on it, or one already going. */
const RunStarted = z
  .object({
    run_id: z.string(),
    started: z.boolean(),
    running: z.boolean().optional(),
    after: z.string().optional(),
  })
  .strict();

/** A long poll waits at most this long, under common host tool-call timeouts. */
const MAX_WAIT_S = 25;
const DEFAULT_WAIT_S = 20;
/**
 * Transient daemon errors (no daemon, a timeout, a dropped socket) retried within one step, about
 * 16 s at watchStep's 2 s interval: long enough to ride out a daemon restart, short enough for
 * host timeouts. An error the daemon answers (an unknown run) is not retried. watchStep also stops
 * one interval past the step's wait, so heph_run (wait 0) gives up after about 2 s.
 */
const STEP_RETRIES = 8;
/** Run statuses `run` would only reject after already answering `started` (runtime.ts build). */
const NOT_RUNNABLE = new Set(["failed", "finished", "staged", "escalated"]);
/** Statuses where `run` resumes a build whatever the approval flag says. */
const RESUMABLE = new Set(["running", "paused", "built"]);

/** status and explain through the guarded client, checked against the CLI's schemas. */
function daemonView(ctx: McpCtx): WatchView {
  const cwd = () => ctx.workspace();
  return {
    status: async (id) => StatusOne.parse(await ctx.client.call("status", [id], cwd())),
    explain: async (id) => Explain.parse(await ctx.client.call("explain", [id], cwd())),
  };
}

const withoutUndefined = <T extends Record<string, unknown>>(o: T): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const { $schema: _dialect, ...briefJsonSchema } = z.toJSONSchema(Brief) as Record<string, unknown>;
// Built from the real schema, so what the model is told cannot drift from what heph_new accepts.
const BRIEF_DESCRIPTION = `A complete Brief object (strict: no extra keys; every list field is required except known_paths, but the brief gate rejects an empty acceptance, any open_questions left unresolved, duplicate criterion ids, a check gate not configured in any project, and known_paths projects not in the workspace). JSON Schema: ${JSON.stringify(briefJsonSchema)}`;

export function registerTools(server: McpServer, ctx: McpCtx): void {
  server.registerTool(
    "heph_plan_show",
    {
      description:
        "Show a heph run's plan: its tasks, build order and risks, and whether the user has approved it.",
      inputSchema: { run: z.string().describe("The run id, e.g. r1") },
    },
    ({ run }) =>
      toolResult(ctx, { method: "planShow", args: [run], command: "plan show" }, planShowText),
  );

  server.registerTool(
    "heph_status",
    {
      description:
        "List heph runs, or show one run: its units, attempts, model usage and pull requests.",
      inputSchema: {
        run: z.string().optional().describe("A run id; omit to list every run"),
      },
    },
    ({ run }) =>
      toolResult(ctx, { method: "status", args: run ? [run] : [], command: "status" }, statusText),
  );

  server.registerTool(
    "heph_explain",
    {
      description: "What happened in a heph run, one line per event; optionally for one unit.",
      inputSchema: {
        run: z.string().describe("The run id, e.g. r1"),
        unit: z.string().optional().describe("Limit the events to this unit id"),
      },
    },
    ({ run, unit }) =>
      toolResult(
        ctx,
        { method: "explain", args: unit ? [run, unit] : [run], command: "explain" },
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
          .optional()
          .describe(
            "Directory of the heph workspace; needed when the server was not started in one",
          ),
        on: z.string().optional().describe('Node to run on; "local" keeps the run here'),
      },
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
      return toolResult(
        ctx,
        { method: "newRun", args: [parsed.data, on ? { on } : {}], command: "new", cwd },
        planResultText,
      );
    },
  );

  server.registerTool(
    "heph_plan_revise",
    {
      description:
        "Plan a run again with the user's feedback. The revised plan needs the user's approval again.",
      inputSchema: {
        run: z.string().describe("The run id, e.g. r1"),
        instructions: z.string().describe("What to change about the plan"),
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
        run: z.string().describe("The run id, e.g. r1"),
        unit: z.string().describe("The unit id"),
        text: z.string().describe("The guidance"),
        scope: z
          .array(z.string())
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
      inputSchema: { run: z.string().describe("The run id, e.g. r1") },
    },
    ({ run }) => toolResult(ctx, { method: "cancel", args: [run], command: "cancel" }, cancelText),
  );

  server.registerTool(
    "heph_run",
    {
      description:
        "Start building a run whose plan the user has approved, and return its first progress lines. If the plan is not approved it does not start; ask the user to approve it themselves. A staged, finished, failed or escalated run, or one with no plan yet, is not started (state not_runnable); do what next says. Follow a started build with heph_watch.",
      inputSchema: { run: z.string().describe("The run id, e.g. r1") },
      outputSchema: RunToolResult.shape,
    },
    async ({ run }) => {
      const view = daemonView(ctx);
      let s: Awaited<ReturnType<WatchView["status"]>>;
      try {
        s = await view.status(run);
      } catch (e) {
        return failure(errorText(e));
      }
      if (s.run.status === "planned" && !s.plan_approved) {
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
        });
      const answer = (
        state: "started" | "already_running" | "not_runnable",
        w: Awaited<ReturnType<typeof watchStep>>,
      ): ToolResult => {
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
        return {
          content: [{ type: "text", text: runText(r) }],
          structuredContent: withoutUndefined(r),
        };
      };
      // `run` answers `started` before the build rejects these, so they are refused here.
      if (NOT_RUNNABLE.has(s.run.status) || !(s.plan_approved || RESUMABLE.has(s.run.status))) {
        // The daemon would answer `started` and only then fail the build: say where it stands.
        try {
          return answer("not_runnable", await step(undefined));
        } catch (e) {
          return failure(errorText(e));
        }
      }
      let started: z.infer<typeof RunStarted>;
      try {
        const raw = await ctx.client.call("run", [run, {}], ctx.workspace());
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
        return answer(started.started ? "started" : "already_running", await step(started.after));
      } catch (e) {
        return failure(errorText(e));
      }
    },
  );

  server.registerTool(
    "heph_watch",
    {
      description: `Wait up to wait_s seconds (default ${DEFAULT_WAIT_S}, at most ${MAX_WAIT_S}) for a run's next milestones and say what it needs. Pass the returned cursor as since on the next call; omit since the first time to catch up. When no cursor is returned, call again with since omitted, but not in a tight loop. Outcomes: running (call again); awaiting_plan_approval; waiting_for_you (paused for the user, e.g. a stalled unit); planner_escalated; waiting_for_parent (a stacked run staged behind a parent that has not merged; waiting_for names it); blocked_by_parent (a stacked run whose parent failed or was cancelled; it needs a rebuild); staged; finished; failed. Stop watching when the outcome is not running and do what next says; approvals are always the user's.`,
      inputSchema: {
        run: z.string().describe("The run id, e.g. r1"),
        since: z
          .string()
          .optional()
          .describe("The cursor from the previous heph_watch or heph_run; omit to catch up"),
        wait_s: z
          .number()
          .optional()
          .describe(`Seconds to wait for news, 0 to ${MAX_WAIT_S}; default ${DEFAULT_WAIT_S}`),
      },
      outputSchema: WatchToolResult.shape,
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
        return {
          content: [{ type: "text", text: watchText(w) }],
          structuredContent: withoutUndefined(w),
        };
      } catch (e) {
        await Promise.all(sent);
        return failure(errorText(e));
      }
    },
  );
}
