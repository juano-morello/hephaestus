import { describe, expect, test } from "bun:test";
import { type DaemonClient, DaemonError, DaemonTimeoutError } from "../../src/daemon.ts";
import {
  ALLOWED_METHODS,
  type AllowedMethod,
  guardedClient,
  isTransient,
  NoDaemonError,
} from "../../src/mcp/guard.ts";
import { buildClient } from "../../src/mcp/serve.ts";

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
  test("allowlist is exactly the nine methods (dashboard is the one read-only addition)", () => {
    expect([...ALLOWED_METHODS]).toEqual([
      "newRun",
      "planShow",
      "revise",
      "run",
      "status",
      "explain",
      "hint",
      "cancel",
      "dashboard",
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

describe("serve wiring", () => {
  test("buildClient guards the socket: a denied method never connects, an allowed one does", async () => {
    const { calls, client } = fake();
    const homes: string[] = [];
    const c = buildClient("/home", async (home) => {
      homes.push(home);
      return client;
    });
    await expect(c.call("approvePlan" as AllowedMethod, ["r1"], "/ws")).rejects.toThrow(
      "not allowed over MCP",
    );
    expect(homes).toEqual([]);
    expect(await c.call("status", ["r1"], "/ws")).toEqual({ ok: "status" });
    expect(homes).toEqual(["/home"]);
    expect(calls).toEqual([{ method: "status", args: ["r1"], cwd: "/ws" }]);
  });
});

describe("per-method timeouts", () => {
  test("quick methods get 10 s, newRun and revise none", async () => {
    const seen: Record<string, unknown> = {};
    const client: DaemonClient = {
      async call(method, _args, _cwd, opts) {
        seen[method] = opts?.timeoutMs;
        return null;
      },
    };
    const mcp = guardedClient(async () => client);
    for (const m of ALLOWED_METHODS) await mcp.call(m, []);
    expect(seen).toEqual({
      newRun: undefined,
      revise: undefined,
      planShow: 10_000,
      run: 10_000,
      status: 10_000,
      explain: 10_000,
      hint: 10_000,
      cancel: 10_000,
      dashboard: 10_000,
    });
  });
});

describe("caller signal", () => {
  test("reaches the daemon call, with or without a timeout", async () => {
    const seen: Record<string, unknown> = {};
    const client: DaemonClient = {
      async call(method, _args, _cwd, opts) {
        seen[method] = opts;
        return null;
      },
    };
    const mcp = guardedClient(async () => client);
    const signal = new AbortController().signal;
    await mcp.call("status", [], undefined, { signal });
    await mcp.call("newRun", [], undefined, { signal });
    expect(seen).toEqual({ status: { timeoutMs: 10_000, signal }, newRun: { signal } });
  });
});

describe("isTransient", () => {
  const coded = (code: string, message = `${code}: x`) =>
    Object.assign(new TypeError(message), { code });
  test("no daemon, a timeout and connection failures are transient", () => {
    expect(isTransient(new NoDaemonError())).toBe(true);
    expect(isTransient(new DaemonTimeoutError("status", 20_000))).toBe(true);
    for (const c of ["ECONNREFUSED", "ENOENT", "ECONNRESET", "ENOTSOCK", "EPIPE"])
      expect(isTransient(coded(c))).toBe(true);
    expect(isTransient(new TypeError("The socket connection was closed unexpectedly"))).toBe(true);
  });
  test("an answered daemon error and anything else are not", () => {
    expect(isTransient(new DaemonError("unknown run r9"))).toBe(false);
    expect(isTransient(new DaemonError("socket closed"))).toBe(false);
    expect(isTransient(new Error("boom"))).toBe(false);
    expect(isTransient("ECONNREFUSED")).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });
});
