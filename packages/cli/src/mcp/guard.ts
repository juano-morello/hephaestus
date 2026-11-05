// The MCP server's only way to the daemon: eight methods, checked before anything is sent.
import type { DaemonClient } from "../daemon.ts";

export const ALLOWED_METHODS = [
  "newRun",
  "planShow",
  "revise",
  "run",
  "status",
  "explain",
  "hint",
  "cancel",
] as const;
export type AllowedMethod = (typeof ALLOWED_METHODS)[number];

export class NoDaemonError extends Error {
  constructor() {
    super(
      "heph daemon is not running: start it with `heph daemon`, or rerun `bun run install:heph`",
    );
    this.name = "NoDaemonError";
  }
}

export type McpClient = {
  call(method: AllowedMethod, args: unknown[], cwd?: string): Promise<unknown>;
};

/** Resolves the daemon on every call, so one started after the server is picked up. */
export function guardedClient(connect: () => Promise<DaemonClient | undefined>): McpClient {
  return {
    async call(method, args, cwd) {
      if (!(ALLOWED_METHODS as readonly string[]).includes(method))
        throw new Error(`method ${JSON.stringify(method)} is not allowed over MCP`);
      const daemon = await connect();
      if (!daemon) throw new NoDaemonError();
      return daemon.call(method, args, cwd);
    },
  };
}
