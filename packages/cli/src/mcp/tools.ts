// The tools a chat host sees. Every one goes through toolResult: daemon call, schema check, text + structured answer.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OUTPUT } from "../output.ts";
import type { AllowedMethod } from "./guard.ts";
import type { McpCtx } from "./server.ts";
import { explainText, planShowText, statusText } from "./text.ts";

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
  call: { method: AllowedMethod; args: unknown[]; command: C },
  render: (data: z.infer<(typeof OUTPUT)[C]>) => string,
): Promise<ToolResult> {
  let raw: unknown;
  try {
    raw = await ctx.client.call(call.method, call.args, ctx.workspace());
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
}
