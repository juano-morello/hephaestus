// The MCP server's only way to the daemon: eight methods, checked before anything is sent.
import { type DaemonClient, DaemonError, DaemonTimeoutError } from "../daemon.ts";

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

/**
 * How long a call may wait for the daemon's answer. newRun and revise run the LLM planner for
 * minutes, so they wait; the rest answer from the ledger (or a peer sync the daemon bounds at
 * about 5 s) and are bounded at 10 s, so two of them fit inside one host tool call.
 */
export const METHOD_TIMEOUT_MS: Record<AllowedMethod, number | undefined> = {
  newRun: undefined,
  revise: undefined,
  planShow: 10_000,
  run: 10_000,
  status: 10_000,
  explain: 10_000,
  hint: 10_000,
  cancel: 10_000,
};

export class NoDaemonError extends Error {
  constructor() {
    super(
      "heph daemon is not running: start it with `heph daemon`, or rerun `bun run install:heph`",
    );
    this.name = "NoDaemonError";
  }
}

export type McpClient = {
  call(
    method: AllowedMethod,
    args: unknown[],
    cwd?: string,
    opts?: { signal?: AbortSignal },
  ): Promise<unknown>;
};

/** Resolves the daemon on every call, so one started after the server is picked up. */
export function guardedClient(connect: () => Promise<DaemonClient | undefined>): McpClient {
  return {
    async call(method, args, cwd, opts) {
      if (!(ALLOWED_METHODS as readonly string[]).includes(method))
        throw new Error(`method ${JSON.stringify(method)} is not allowed over MCP`);
      const daemon = await connect();
      if (!daemon) throw new NoDaemonError();
      const timeoutMs = METHOD_TIMEOUT_MS[method];
      const signal = opts?.signal;
      const o = {
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(signal === undefined ? {} : { signal }),
      };
      return Object.keys(o).length
        ? daemon.call(method, args, cwd, o)
        : daemon.call(method, args, cwd);
    },
  };
}

/** Socket-level failures: the daemon is restarting or gone, not refusing. */
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOENT",
  "ENOTSOCK",
  "EPIPE",
  "ConnectionRefused",
  "ConnectionClosed",
]);

/**
 * Whether a failed daemon call is worth retrying: no daemon, a timeout, or a connection-level
 * failure. An error the daemon answered (an unknown run, a refusal) is not, nor is anything else.
 */
export function isTransient(e: unknown): boolean {
  if (e instanceof DaemonError) return false;
  if (e instanceof NoDaemonError || e instanceof DaemonTimeoutError) return true;
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && CONNECTION_CODES.has(code)) return true;
  return /socket (connection )?(was )?closed/i.test(e.message);
}
