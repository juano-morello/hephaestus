// serveStdio's own wiring: the ctx it builds hands the server only the guarded client.
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DaemonClient } from "../../src/daemon.ts";
import type { AllowedMethod } from "../../src/mcp/guard.ts";
import { serveStdio } from "../../src/mcp/serve.ts";
import type { McpCtx } from "../../src/mcp/server.ts";

test("serveStdio gives the server the guarded client, never the raw daemon", async () => {
  const connects: string[] = [];
  const calls: string[] = [];
  const daemon: DaemonClient = {
    async call(method) {
      calls.push(method);
      return { runs: [] };
    },
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  let ctx: McpCtx | undefined;
  const served = serveStdio(
    { home: "/h", workspace: () => "/ws" },
    {
      transport: serverSide,
      connect: async (home) => {
        connects.push(home);
        return daemon;
      },
      onReady: (c) => {
        ctx = c;
      },
    },
  );
  const client = new Client({ name: "heph-test", version: "0" });
  await client.connect(clientSide);
  expect(ctx).toBeDefined();
  const c = ctx as McpCtx;

  await expect(c.client.call("approvePlan" as AllowedMethod, ["r1"])).rejects.toThrow(
    "not allowed over MCP",
  );
  await expect(c.client.call("approveMerge" as AllowedMethod, ["r1"])).rejects.toThrow(
    "not allowed over MCP",
  );
  expect(connects).toEqual([]);
  expect(calls).toEqual([]);

  const r = await client.callTool({ name: "heph_status", arguments: {} });
  expect(r.isError).toBeFalsy();
  expect(connects).toEqual(["/h"]);
  expect(calls).toEqual(["status"]);

  await client.close();
  await served;
});
