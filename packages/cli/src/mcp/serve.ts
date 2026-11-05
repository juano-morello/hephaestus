// `heph mcp`: the MCP server over stdio. Stdout is the protocol channel; log only to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type DaemonClient, daemonAt } from "../daemon.ts";
import { guardedClient, type McpClient } from "./guard.ts";
import { createMcpServer } from "./server.ts";

/** The only client the server gets: the allowlist guard in front of the daemon socket. */
export const buildClient = (
  home: string,
  connect: (home: string) => Promise<DaemonClient | undefined> = daemonAt,
): McpClient => guardedClient(() => connect(home));

/** Serves until the host closes stdin. */
export async function serveStdio(o: {
  home: string;
  workspace: () => string | undefined;
}): Promise<void> {
  const server = createMcpServer({
    client: buildClient(o.home),
    workspace: o.workspace,
    cwd: process.cwd(),
  });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((done) => {
    transport.onclose = done;
  });
  server.server.onerror = (e) => process.stderr.write(`heph mcp: ${e.message}\n`);
  await server.connect(transport);
  // The SDK's transport does not notice stdin ending; the host hanging up is the close.
  process.stdin.once("end", () => void transport.close());
  await closed;
}
