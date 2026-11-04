// `heph daemon` (SPEC section 16): owns this node's runs. Clients talk to it over HTTP on a
// Unix socket in $HEPH_HOME, so nothing listens on the network; other nodes reach this one
// through `ssh <host> heph peer`, which hands builds to the daemon.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "./host.ts";

export const socketOf = (home: string) => join(home, "daemon.sock");

export type DaemonClient = {
  call(method: string, args: unknown[], cwd?: string): Promise<unknown>;
};

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
    async call(method, args, cwd) {
      const r = await fetch("http://heph/call", {
        unix,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, args, cwd }),
      });
      const body = (await r.json()) as { ok: boolean; data?: unknown; error?: { message: string } };
      if (!body.ok) throw new Error(body.error?.message ?? `daemon answered ${r.status}`);
      return body.data;
    },
  };
}

export type Daemon = { stop(): Promise<void>; socket: string };

/**
 * Serves a host on its home's socket, resumes runs a killed process left running, and syncs
 * with the configured nodes every `interval_s`.
 */
export async function startDaemon(
  host: Host,
  o: { home: string; intervalS: number; log?: (line: string) => void },
): Promise<Daemon> {
  const unix = socketOf(o.home);
  if (await daemonAt(o.home)) throw new Error(`a daemon is already running for ${o.home}`);
  // A socket file nothing answers on is what a killed daemon leaves behind.
  if (existsSync(unix)) rmSync(unix);
  const server = Bun.serve({
    unix,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ node: host.node, pid: process.pid });
      if (url.pathname !== "/call" || req.method !== "POST")
        return new Response("not found", { status: 404 });
      const { method, args, cwd } = (await req.json()) as {
        method: string;
        args: unknown[];
        cwd?: string;
      };
      try {
        return Response.json({ ok: true, data: await host.api.call(method, args, cwd) });
      } catch (e) {
        return Response.json({
          ok: false,
          error: { message: e instanceof Error ? e.message : String(e) },
        });
      }
    },
  });
  const resumed = await host.resumeOnStart();
  if (resumed.length) o.log?.(`resumed ${resumed.join(", ")}`);
  let syncing = false;
  const timer = setInterval(async () => {
    if (syncing) return;
    syncing = true;
    try {
      for (const r of await host.syncAll())
        if (!r.ok) o.log?.(`sync with ${r.node} failed: ${r.error}`);
    } finally {
      syncing = false;
    }
  }, o.intervalS * 1000);
  return {
    socket: unix,
    async stop() {
      clearInterval(timer);
      await server.stop(true);
      rmSync(unix, { force: true });
    },
  };
}
