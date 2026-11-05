// heph as an MCP server: the tools a chat host sees. Every daemon call goes through McpClient.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hephVersion } from "../version.ts";
import type { McpClient } from "./guard.ts";
import { registerTools } from "./tools.ts";

export type McpCtx = {
  client: McpClient;
  /** The workspace the host started heph in, if it is one. */
  workspace: () => string | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export function createMcpServer(ctx: McpCtx): McpServer {
  const server = new McpServer({ name: "heph", version: hephVersion().version });
  registerTools(server, ctx);
  return server;
}
