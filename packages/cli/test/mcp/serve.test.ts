// serveStdio's own wiring: the ctx it builds hands the server only the guarded client.
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DaemonClient } from "../../src/daemon.ts";
import { ALLOWED_METHODS, type AllowedMethod, METHOD_TIMEOUT_MS } from "../../src/mcp/guard.ts";
import { serveStdio } from "../../src/mcp/serve.ts";
import type { McpCtx } from "../../src/mcp/server.ts";

test("serveStdio gives the server the guarded client, never the raw daemon", async () => {
  const connects: string[] = [];
  const calls: string[] = [];
  const opts: unknown[] = [];
  const daemon: DaemonClient = {
    async call(method, _args, _cwd, o) {
      calls.push(method);
      opts.push(o?.timeoutMs);
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

  // What the server's own tools reach: only allowlisted methods, each through the guard,
  // which a raw daemon client would not be (it adds no per-method timeout).
  const r = await client.callTool({ name: "heph_status", arguments: {} });
  expect(r.isError).toBeFalsy();
  await client.callTool({ name: "heph_plan_show", arguments: { run: "r1" } });
  await client.callTool({ name: "heph_cancel", arguments: { run: "r1" } });
  expect(connects).toEqual(["/h", "/h", "/h"]);
  expect(calls).toEqual(["status", "planShow", "cancel"]);
  for (const m of calls) expect(ALLOWED_METHODS as readonly string[]).toContain(m);
  expect(opts).toEqual(calls.map((m) => METHOD_TIMEOUT_MS[m as AllowedMethod]));
  expect(opts).toEqual([10_000, 10_000, 10_000]);

  await client.close();
  await served;
});
