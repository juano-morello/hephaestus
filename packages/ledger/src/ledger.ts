import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type BlobStore, createBlobStore } from "./blobs.ts";
import { type Db, openDb } from "./db.ts";
import {
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
import { insertEvent, migrateStore, type ReadFilter, readEvents } from "./store.ts";
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
  /** Drops every projection and replays all events. */
  rebuildProjections(): void;
  close(): void;
} & ReturnType<typeof queries>;

export class InvalidEventError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid event: ${issues.join("; ")}`);
  }
}

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

  const stamp = (draft: EventDraft): LedgerEvent => {
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
    const missing = Object.entries(result.event.blobs ?? {})
      .filter(([, sha]) => sha && !blobs.has(sha))
      .map(([key, sha]) => `blobs.${key}: blob ${sha} is not in the store`);
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

  return {
    nodeId: opts.nodeId,
    blobs,
    append: <K extends EventType>(draft: EventDraft<K>) =>
      appendMany([draft as EventDraft])[0] as LedgerEvent<K>,
    appendMany,
    read: (filter) => readEvents(db, filter),
    rebuildProjections: () => rebuildProjections(db),
    ...queries(db),
    close: () => db.close(),
  };
}
