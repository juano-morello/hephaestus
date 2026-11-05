// `heph mcp`: the MCP server over stdio. Stdout is the protocol channel; log only to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { daemonAt } from "../daemon.ts";
import { guardedClient } from "./guard.ts";
import { createMcpServer } from "./server.ts";

/** Serves until the host closes stdin. */
export async function serveStdio(o: {
  home: string;
  workspace: () => string | undefined;
}): Promise<void> {
  const server = createMcpServer({
    client: guardedClient(() => daemonAt(o.home)),
    workspace: o.workspace,
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
