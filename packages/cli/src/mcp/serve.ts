// `heph mcp`: the MCP server over stdio. Stdout is the protocol channel; log only to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type DaemonClient, daemonAt } from "../daemon.ts";
import { guardedClient, type McpClient } from "./guard.ts";
import { createMcpServer, type McpCtx } from "./server.ts";

/** The only client the server gets: the allowlist guard in front of the daemon socket. */
export const buildClient = (
  home: string,
  connect: (home: string) => Promise<DaemonClient | undefined> = daemonAt,
): McpClient => guardedClient(() => connect(home));

/** Test seams; production passes none of them. */
export type ServeDeps = {
  /** Defaults to stdio; only stdio watches stdin for the host hanging up. */
  transport?: Transport;
  connect?: (home: string) => Promise<DaemonClient | undefined>;
  /** Sees the ctx the server was built with, once it is connected. */
  onReady?: (ctx: McpCtx) => void;
};

/** Serves until the host closes stdin (or the transport closes). */
export async function serveStdio(
  o: { home: string; workspace: () => string | undefined },
  deps: ServeDeps = {},
): Promise<void> {
  const ctx: McpCtx = {
    client: buildClient(o.home, deps.connect),
    workspace: o.workspace,
    home: o.home,
    cwd: process.cwd(),
  };
  const server = createMcpServer(ctx);
  const transport = deps.transport ?? new StdioServerTransport();
  const closed = new Promise<void>((done) => {
    transport.onclose = done;
  });
  server.server.onerror = (e) => process.stderr.write(`heph mcp: ${e.message}\n`);
  await server.connect(transport);
  // The SDK's transport does not notice stdin ending; the host hanging up is the close.
  if (!deps.transport) process.stdin.once("end", () => void transport.close());
  deps.onReady?.(ctx);
  await closed;
}
