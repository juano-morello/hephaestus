// `heph daemon` (SPEC section 16): owns this node's runs. Clients talk to it over HTTP on a
// Unix socket in $HEPH_HOME, so nothing listens on the network; other nodes reach this one
// through `ssh <host> heph peer`, which hands builds to the daemon.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "./host.ts";
import { createNodeHealth } from "./node-health.ts";
import { mergeHealth } from "./nodes.ts";
import { startUiServer, type UiAssets } from "./ui-server.ts";

export const socketOf = (home: string) => join(home, "daemon.sock");

export type DaemonClient = {
  /**
   * `timeoutMs` bounds the call; without it the call waits (newRun and revise plan for minutes).
   * `signal` lets the caller abort it; the call then rejects with the signal's reason.
   */
  call(
    method: string,
    args: unknown[],
    cwd?: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown>;
};

/** An error the daemon answered with (`ok: false`): it is up and said no. */
export class DaemonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonError";
  }
}

/** A call that got no answer within its timeout: the daemon may be busy or stuck. */
export class DaemonTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`the heph daemon did not answer ${method} within ${ms / 1000} s`);
    this.name = "DaemonTimeoutError";
  }
}

/** The running daemon of a home, or undefined when none answers. */
export async function daemonAt(home: string): Promise<DaemonClient | undefined> {
  const unix = socketOf(home);
  if (!existsSync(unix)) return undefined;
  try {
    const r = await fetch("http://heph/health", { unix, signal: AbortSignal.timeout(1000) });
    if (!r.ok) return undefined;
  } catch {
    return undefined;
  }
  return {
    async call(method, args, cwd, opts) {
      const ms = opts?.timeoutMs;
      const timeout = ms === undefined ? undefined : AbortSignal.timeout(ms);
      const signals = [timeout, opts?.signal].filter((x): x is AbortSignal => x !== undefined);
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      let r: Response;
      let body: { ok: boolean; data?: unknown; error?: { message: string } };
      try {
        r = await fetch("http://heph/call", {
          unix,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method, args, cwd }),
          ...(signal ? { signal } : {}),
        });
        body = (await r.json()) as typeof body;
      } catch (e) {
        if (opts?.signal?.aborted) throw opts.signal.reason;
        if (ms !== undefined && timeout?.aborted) throw new DaemonTimeoutError(method, ms);
        throw e;
      }
      if (!body.ok) throw new DaemonError(body.error?.message ?? `daemon answered ${r.status}`);
      return body.data;
    },
  };
}

export type Daemon = { stop(): Promise<void>; socket: string; ui?: { port: number } };

/**
 * Serves a host on its home's socket, resumes runs a killed process left running, and syncs
 * with the configured nodes every `interval_s`.
 */
export async function startDaemon(
  host: Host,
  o: {
    home: string;
    intervalS: number;
    log?: (line: string) => void;
    /** The dashboard bundle; without it no UI listener starts. */
    uiAssets?: UiAssets;
    /** Test injection: the preferred dashboard port. */
    uiPort?: number;
  },
): Promise<Daemon> {
  const unix = socketOf(o.home);
  if (await daemonAt(o.home)) throw new Error(`a daemon is already running for ${o.home}`);
  // A socket file nothing answers on is what a killed daemon leaves behind.
  if (existsSync(unix)) rmSync(unix);
  const health = createNodeHealth({ intervalS: o.intervalS, ...(o.log ? { log: o.log } : {}) });
  const server = Bun.serve({
    unix,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health")
        return Response.json({ node: host.node, pid: process.pid, nodes: health.snapshot() });
      if (url.pathname !== "/call" || req.method !== "POST")
        return new Response("not found", { status: 404 });
      const { method, args, cwd } = (await req.json()) as {
        method: string;
        args: unknown[];
        cwd?: string;
      };
      try {
        const data = await host.api.call(method, args, cwd);
        // `heph status` with no run, and `heph nodes`: which peers this daemon can reach.
        return Response.json({
          ok: true,
          data: mergeHealth(method, args, data, health.snapshot()),
        });
      } catch (e) {
        return Response.json({
          ok: false,
          error: { message: e instanceof Error ? e.message : String(e) },
        });
      }
    },
  });
  let ui: Awaited<ReturnType<typeof startUiServer>>;
  let timer: ReturnType<typeof setInterval> | undefined;
  // Whatever fails from here on must not leave the socket or the listener running behind a throw.
  try {
    try {
      ui = o.uiAssets
        ? await startUiServer({
            home: o.home,
            call: (m, a) => host.api.call(m, a, undefined),
            assets: o.uiAssets,
            ...(o.uiPort !== undefined ? { port: o.uiPort } : {}),
            ...(o.log ? { log: o.log } : {}),
          })
        : undefined;
    } catch (e) {
      // The dashboard is optional: the daemon runs without it.
      o.log?.(`dashboard not started: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (ui) o.log?.(`dashboard on http://127.0.0.1:${ui.port}`);
    const resumed = await host.resumeOnStart();
    if (resumed.length) o.log?.(`resumed ${resumed.join(", ")}`);
    let syncing = false;
    timer = setInterval(async () => {
      if (syncing) return;
      syncing = true;
      try {
        for (const r of await host.syncAll((n) => health.due(n)))
          health.record(r.node, r.ok ? { ok: true } : { ok: false, error: r.error ?? "failed" });
      } finally {
        syncing = false;
      }
    }, o.intervalS * 1000);
  } catch (e) {
    clearInterval(timer);
    await ui?.stop();
    await server.stop(true);
    rmSync(unix, { force: true });
    throw e;
  }
  return {
    socket: unix,
    ...(ui ? { ui: { port: ui.port } } : {}),
    async stop() {
      clearInterval(timer);
      await ui?.stop();
      await server.stop(true);
      rmSync(unix, { force: true });
    },
  };
}
