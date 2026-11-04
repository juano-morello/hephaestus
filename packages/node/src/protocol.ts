import type { Envelope, Ledger } from "@hephaestus/ledger";

/**
 * Node to node (SPEC section 7): one JSON request per line, one JSON response per line, over
 * the stdio of `heph peer` (reached through `ssh <host> heph peer`). Bumped on any change a
 * peer on the previous version can't read.
 */
export const PROTOCOL_VERSION = 1;

export type Request = { id: number; method: string; params: unknown };
export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string } };

/** Blobs travel as base64 inside the JSON. */
export type WireBlobs = Record<string, string>;

export type Hello = {
  node: string;
  protocol: number;
  /** The peer's cursor for the caller: how far it has imported the caller's events. */
  cursor: number;
  /** The peer's heph version, when it says (0.1.0 on). */
  version?: string;
};

export type Batch = { seq: number; events: Envelope[]; blobs: WireBlobs; more: boolean };

export const toWire = (ledger: Ledger, events: Envelope[]): WireBlobs =>
  Object.fromEntries(
    events
      .flatMap((e) => Object.values(e.blobs ?? {}))
      .filter((sha): sha is string => !!sha)
      .map((sha) => [sha, Buffer.from(ledger.blobs.get(sha)).toString("base64")]),
  );

export const fromWire = (blobs: WireBlobs): Record<string, Uint8Array> =>
  Object.fromEntries(
    Object.entries(blobs).map(([sha, b64]) => [sha, new Uint8Array(Buffer.from(b64, "base64"))]),
  );

/** The far side: a method name -> what it does with the params. */
export type Methods = Record<string, (params: never) => unknown | Promise<unknown>>;

export class PeerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerError";
  }
}

/** The methods every node serves for sync. More (workspace, rpc) are added by the node. */
export function syncMethods(
  ledger: Ledger,
  opts: { pageSize?: number; version?: string } = {},
): Methods {
  const page = opts.pageSize ?? 500;
  return {
    hello: (p: { from: string; protocol: number }): Hello => {
      if (p.protocol !== PROTOCOL_VERSION)
        throw new PeerError(
          `protocol ${p.protocol} is not supported by ${ledger.nodeId} (speaks ${PROTOCOL_VERSION})`,
        );
      return {
        node: ledger.nodeId,
        protocol: PROTOCOL_VERSION,
        cursor: ledger.cursor(p.from),
        ...(opts.version ? { version: opts.version } : {}),
      };
    },
    "events.since": (p: { seq: number }): Batch => {
      const b = ledger.since(p.seq, page + 1);
      const events = b.events.slice(0, page);
      const more = b.events.length > page;
      const seq = more ? ledger.since(p.seq, page).seq : b.seq;
      return { seq, events, blobs: toWire(ledger, events), more };
    },
    "events.push": (p: { from: string; seq: number; events: Envelope[]; blobs: WireBlobs }) => {
      const imported = ledger.import(p.events, fromWire(p.blobs));
      if (p.seq > ledger.cursor(p.from)) ledger.setCursor(p.from, p.seq);
      return { imported };
    },
  };
}

/** Answers one request line. Errors become `ok: false`; they never end the session. */
export async function answer(methods: Methods, line: string): Promise<Response> {
  let req: Request;
  try {
    req = JSON.parse(line) as Request;
  } catch {
    return { id: -1, ok: false, error: { message: "request is not JSON" } };
  }
  const fn = methods[req.method];
  if (!fn) return { id: req.id, ok: false, error: { message: `unknown method ${req.method}` } };
  try {
    return { id: req.id, ok: true, result: await fn(req.params as never) };
  } catch (e) {
    return {
      id: req.id,
      ok: false,
      error: { message: e instanceof Error ? e.message : String(e) },
    };
  }
}
