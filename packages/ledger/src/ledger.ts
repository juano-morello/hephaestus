import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type BlobStore, createBlobStore } from "./blobs.ts";
import { type Db, openDb } from "./db.ts";
import {
  Envelope,
  EVENT_TYPES,
  type EventDraft,
  type EventType,
  type LedgerEvent,
  type StoredEvent,
  validateEvent,
} from "./events.ts";
import {
  initProjections,
  projectAppended,
  queries,
  rebuildProjections,
} from "./projections/index.ts";
import {
  hasEvent,
  insertEvent,
  migrateStore,
  type ReadFilter,
  readEvents,
  readSince,
} from "./store.ts";
import { createUlid, decodeTime } from "./ulid.ts";

export type LedgerOptions = {
  nodeId: string;
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
  /** Called with each batch after it is committed (e.g. progress output). */
  onAppend?: (events: LedgerEvent[]) => void;
};

export type Ledger = {
  readonly nodeId: string;
  readonly blobs: BlobStore;
  append<K extends EventType>(draft: EventDraft<K>): LedgerEvent<K>;
  /** All or nothing. */
  appendMany(drafts: EventDraft[]): LedgerEvent[];
  read(filter?: ReadFilter): StoredEvent[];
  /** For a peer: events after `seq` in this node's arrival order (SPEC section 7 sync). */
  since(seq: number, limit?: number): { seq: number; events: Envelope[] };
  /**
   * Events written on other nodes, kept as they are (id, ts, node_id). Ids already here are
   * skipped; blobs they reference must be in `blobs` or already stored. All or nothing.
   * Returns how many were new.
   */
  import(events: Envelope[], blobs: Record<string, Uint8Array>): number;
  /** The last of a peer's seq numbers imported from it; 0 for a peer never synced. */
  cursor(peer: string): number;
  setCursor(peer: string, seq: number): void;
  /** Drops every projection and replays all events. */
  rebuildProjections(): void;
  close(): void;
} & ReturnType<typeof queries>;

export class InvalidEventError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid event: ${issues.join("; ")}`);
  }
}

/** SPEC section 7: only a run's owner writes its events. */
export class NotOwnerError extends Error {
  constructor(
    readonly runId: string,
    readonly owner: string,
    readonly node: string,
  ) {
    super(`run ${runId} is owned by ${owner}; ${node} can't write its events`);
    this.name = "NotOwnerError";
  }
}

/** Events any node may write for a run: creating it, and taking it over from a lost owner. */
const ANY_WRITER = new Set(["run.created", "run.adopted"]);

/** One ledger per node (SPEC section 6): `<dir>/ledger.db` plus `<dir>/blobs/`. */
export function openLedger(dir: string, opts: LedgerOptions): Ledger {
  mkdirSync(dir, { recursive: true });
  const db: Db = openDb(join(dir, "ledger.db"));
  migrateStore(db);
  initProjections(db);
  const blobs = createBlobStore(join(dir, "blobs"));
  const now = opts.now ?? Date.now;
  // One clock reading per event, shared by the id and ts so they always agree.
  let tick = 0;
  const ulid = createUlid({ now: () => tick, ...(opts.random ? { random: opts.random } : {}) });

  const ownerOf = (runId: string) =>
    db.prepare("SELECT owner_node FROM runs WHERE run_id = ?").get<{ owner_node: string }>(runId)
      ?.owner_node;
  const missingBlobs = (e: Envelope) =>
    Object.entries(e.blobs ?? {})
      .filter(([, sha]) => sha && !blobs.has(sha))
      .map(([key, sha]) => `blobs.${key}: blob ${sha} is not in the store`);

  const stamp = (draft: EventDraft): LedgerEvent => {
    const owner = ownerOf(draft.run_id);
    if (owner && owner !== opts.nodeId && !ANY_WRITER.has(draft.type))
      throw new NotOwnerError(draft.run_id, owner, opts.nodeId);
    tick = now();
    const id = ulid();
    const result = validateEvent({
      ...draft,
      id,
      ts: new Date(decodeTime(id)).toISOString(),
      schema: 1,
      node_id: opts.nodeId,
    });
    if (!result.ok) throw new InvalidEventError(result.issues);
    const missing = missingBlobs(result.event);
    if (missing.length) throw new InvalidEventError(missing);
    return result.event;
  };

  // Insert and project in one transaction: a projection error rolls the events back too.
  const appendMany = (drafts: EventDraft[]) => {
    const events = db.transaction(() => {
      const stamped = drafts.map((d) => {
        const e = stamp(d);
        insertEvent(db, e);
        return e;
      });
      projectAppended(db);
      return stamped;
    });
    opts.onAppend?.(events);
    return events;
  };

  const importEvents = (events: Envelope[], incoming: Record<string, Uint8Array>) => {
    for (const [sha, bytes] of Object.entries(incoming)) {
      if (blobs.has(sha)) continue;
      const stored = blobs.put(bytes);
      if (stored !== sha) throw new InvalidEventError([`blob ${sha} does not match its content`]);
    }
    return db.transaction(() => {
      let added = 0;
      for (const raw of events) {
        const env = Envelope.safeParse(raw);
        if (!env.success)
          throw new InvalidEventError([`invalid synced event: ${env.error.message}`]);
        const e = env.data;
        if (hasEvent(db, e.id)) continue;
        // Known types get the full check; a newer node's types are kept as they are.
        if (Object.hasOwn(EVENT_TYPES, e.type)) {
          const v = validateEvent(e);
          if (!v.ok) throw new InvalidEventError(v.issues);
        }
        const missing = missingBlobs(e);
        if (missing.length) throw new InvalidEventError(missing);
        insertEvent(db, e);
        added++;
      }
      projectAppended(db);
      return added;
    });
  };

  return {
    nodeId: opts.nodeId,
    blobs,
    since: (seq, limit = 1000) => readSince(db, seq, limit),
    import: importEvents,
    cursor: (peer) =>
      db.prepare("SELECT seq FROM sync_cursors WHERE peer = ?").get<{ seq: number }>(peer)?.seq ??
      0,
    setCursor: (peer, seq) =>
      db
        .prepare(
          "INSERT INTO sync_cursors (peer, seq) VALUES (?, ?) ON CONFLICT (peer) DO UPDATE SET seq = excluded.seq",
        )
        .run(peer, seq),
    append: <K extends EventType>(draft: EventDraft<K>) =>
      appendMany([draft as EventDraft])[0] as LedgerEvent<K>,
    appendMany,
    read: (filter) => readEvents(db, filter),
    rebuildProjections: () => rebuildProjections(db),
    ...queries(db),
    close: () => db.close(),
  };
}
