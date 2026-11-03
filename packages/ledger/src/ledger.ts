import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type BlobStore, createBlobStore } from "./blobs.ts";
import { type Db, openDb } from "./db.ts";
import type { StoredEvent } from "./events.ts";
import { type EventDraft, type EventType, type LedgerEvent, validateEvent } from "./events.ts";
import { insertEvent, migrateStore, type ReadFilter, readEvents } from "./store.ts";
import { createUlid } from "./ulid.ts";

export type LedgerOptions = {
  nodeId: string;
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
};

export type Ledger = {
  readonly nodeId: string;
  readonly blobs: BlobStore;
  append<K extends EventType>(draft: EventDraft<K>): LedgerEvent<K>;
  /** All or nothing. */
  appendMany(drafts: EventDraft[]): LedgerEvent[];
  read(filter?: ReadFilter): StoredEvent[];
  close(): void;
};

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
  const blobs = createBlobStore(join(dir, "blobs"));
  const now = opts.now ?? Date.now;
  const ulid = createUlid({ now, ...(opts.random ? { random: opts.random } : {}) });

  const stamp = (draft: EventDraft): LedgerEvent => {
    const t = now();
    const result = validateEvent({
      ...draft,
      id: ulid(),
      ts: new Date(t).toISOString(),
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

  const appendMany = (drafts: EventDraft[]) =>
    db.transaction(() =>
      drafts.map((d) => {
        const e = stamp(d);
        insertEvent(db, e);
        return e;
      }),
    );

  return {
    nodeId: opts.nodeId,
    blobs,
    append: <K extends EventType>(draft: EventDraft<K>) =>
      appendMany([draft as EventDraft])[0] as LedgerEvent<K>,
    appendMany,
    read: (filter) => readEvents(db, filter),
    close: () => db.close(),
  };
}
