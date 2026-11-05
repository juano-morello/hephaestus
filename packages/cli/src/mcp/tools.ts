// The tools a chat host sees. Every one goes through toolResult: daemon call, schema check, text + structured answer.

import { Brief } from "@hephaestus/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OUTPUT } from "../output.ts";
import type { AllowedMethod } from "./guard.ts";
import type { McpCtx } from "./server.ts";
import {
  cancelText,
  explainText,
  hintText,
  planResultText,
  planShowText,
  statusText,
} from "./text.ts";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: true;
};

const failure = (text: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

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
    return failure(e instanceof Error ? e.message : String(e));
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

const { $schema: _dialect, ...briefJsonSchema } = z.toJSONSchema(Brief) as Record<string, unknown>;
// Built from the real schema, so what the model is told cannot drift from what heph_new accepts.
const BRIEF_DESCRIPTION = `A complete Brief object (strict: no extra keys; every list field is required, but the brief gate rejects an empty acceptance, any open_questions left unresolved, duplicate criterion ids, and known_paths projects not in the workspace). JSON Schema: ${JSON.stringify(briefJsonSchema)}`;

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
      const cwd = workspace ?? ctx.workspace();
      if (!cwd)
        return failure(
          "no heph workspace directory: the server was not started in one, so pass the workspace argument (the directory that holds .heph/)",
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
}
