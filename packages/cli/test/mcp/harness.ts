// Test-only wiring: an SDK client talking to the heph MCP server in memory, and a fake daemon.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AllowedMethod, McpClient } from "../../src/mcp/guard.ts";
import { createMcpServer, type McpCtx } from "../../src/mcp/server.ts";

export async function connectTestClient(ctx: McpCtx): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(ctx).connect(serverSide);
  const client = new Client({ name: "heph-test", version: "0" });
  await client.connect(clientSide);
  return client;
}

/** A daemon that answers with the given handlers and records every call made to it. */
export function fakeDaemon(
  handlers: Partial<Record<AllowedMethod, (args: unknown[], cwd?: string) => unknown>>,
): { client: McpClient; calls: { method: string; args: unknown[]; cwd?: string }[] } {
  const calls: { method: string; args: unknown[]; cwd?: string }[] = [];
  return {
    calls,
    client: {
      async call(method, args, cwd) {
        calls.push({ method, args, ...(cwd === undefined ? {} : { cwd }) });
        const h = handlers[method];
        if (!h) throw new Error(`fake daemon has no handler for ${method}`);
        return h(args, cwd);
      },
    },
  };
}
