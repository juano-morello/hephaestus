import { describe, expect, test } from "bun:test";
import type { DaemonClient } from "../../src/daemon.ts";
import {
  ALLOWED_METHODS,
  type AllowedMethod,
  guardedClient,
  NoDaemonError,
} from "../../src/mcp/guard.ts";

function fake() {
  const calls: { method: string; args: unknown[]; cwd?: string }[] = [];
  const client: DaemonClient = {
    async call(method, args, cwd) {
      calls.push({ method, args, cwd });
      return { ok: method };
    },
  };
  return { calls, client };
}

describe("mcp guard", () => {
  test("allowlist is exactly the eight methods", () => {
    expect([...ALLOWED_METHODS]).toEqual([
      "newRun",
      "planShow",
      "revise",
      "run",
      "status",
      "explain",
      "hint",
      "cancel",
    ]);
  });

  test("every non-listed method throws before reaching the daemon", async () => {
    const { calls, client } = fake();
    const mcp = guardedClient(async () => client);
    for (const m of [
      "approvePlan",
      "approveMerge",
      "handoff",
      "adopt",
      "sync",
      "follow",
      "resume",
      "",
      "constructor",
    ])
      await expect(mcp.call(m as AllowedMethod, [])).rejects.toThrow(/not allowed/);
    expect(calls).toEqual([]);
  });

  test("allowed methods pass method, args and cwd through", async () => {
    const { calls, client } = fake();
    const mcp = guardedClient(async () => client);
    for (const m of ALLOWED_METHODS)
      expect(await mcp.call(m, [1, "x"], "/work")).toEqual({ ok: m });
    expect(calls).toHaveLength(ALLOWED_METHODS.length);
    expect(calls[0]).toEqual({ method: "newRun", args: [1, "x"], cwd: "/work" });
  });

  test("re-resolves the daemon on every call", async () => {
    const { client } = fake();
    const answers: (DaemonClient | undefined)[] = [undefined, client];
    const mcp = guardedClient(async () => answers.shift());
    await expect(mcp.call("status", [])).rejects.toBeInstanceOf(NoDaemonError);
    expect(await mcp.call("status", [])).toEqual({ ok: "status" });
  });
});
