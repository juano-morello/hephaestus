import type { Ledger } from "@hephaestus/ledger";
import {
  type Batch,
  fromWire,
  type Hello,
  PeerError,
  PROTOCOL_VERSION,
  toWire,
} from "./protocol.ts";
import type { Transport } from "./transport.ts";

const PUSH_PAGE = 500;

export type SyncResult = { peer: string; pulled: number; pushed: number };

/** Says hello: the peer's node id and how far it has imported this node's events. */
export async function hello(ledger: Ledger, t: Transport): Promise<Hello> {
  const h = await t.request<Hello>("hello", { from: ledger.nodeId, protocol: PROTOCOL_VERSION });
  if (h.node === ledger.nodeId)
    throw new PeerError(`the peer says it is ${h.node}, which is this node's own id`);
  return h;
}

/**
 * Event union with one peer (SPEC section 7): pull everything it has after our cursor for it,
 * then push everything we have after its cursor for us. Ids already present are skipped on
 * both sides, so running it again, or with a third node in between, changes nothing.
 */
export async function syncWith(ledger: Ledger, t: Transport): Promise<SyncResult> {
  const h = await hello(ledger, t);
  const peer = h.node;

  let pulled = 0;
  for (;;) {
    const b = await t.request<Batch>("events.since", { seq: ledger.cursor(peer) });
    if (b.events.length) pulled += ledger.import(b.events, fromWire(b.blobs));
    if (b.seq > ledger.cursor(peer)) ledger.setCursor(peer, b.seq);
    if (!b.more) break;
  }

  let pushed = 0;
  let seq = h.cursor;
  for (;;) {
    const page = ledger.since(seq, PUSH_PAGE);
    if (!page.events.length) break;
    // What the peer wrote itself it already has; the cursor still moves past it.
    const events = page.events.filter((e) => e.node_id !== peer);
    const r = await t.request<{ imported: number }>("events.push", {
      from: ledger.nodeId,
      seq: page.seq,
      events,
      blobs: toWire(ledger, events),
    });
    pushed += r.imported;
    seq = page.seq;
    if (page.events.length < PUSH_PAGE) break;
  }
  return { peer, pulled, pushed };
}
