import type { Db, SqlValue } from "./db.ts";
import { type Envelope, parseStoredEvent, type StoredEvent } from "./events.ts";

const COLUMNS = [
  "id",
  "ts",
  "type",
  "schema",
  "node_id",
  "run_id",
  "changeset_id",
  "repo",
  "project",
  "graph_node",
  "unit_id",
  "attempt",
  "runner_id",
  "actor",
  "config_hash",
  "prompt_hash",
] as const;

/**
 * `seq` is the local arrival order (projection cursor); `id` is the global ULID order (reads).
 * They coincide for locally written events and differ only once events are synced in.
 */
export function migrateStore(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      schema INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      changeset_id TEXT NOT NULL,
      repo TEXT,
      project TEXT,
      graph_node TEXT,
      unit_id TEXT,
      attempt INTEGER,
      runner_id TEXT,
      actor TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      prompt_hash TEXT,
      data TEXT NOT NULL,
      blobs TEXT
    );
    CREATE INDEX IF NOT EXISTS events_run ON events (run_id, unit_id);
    CREATE INDEX IF NOT EXISTS events_unit ON events (unit_id);
    CREATE INDEX IF NOT EXISTS events_type ON events (type);
    CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'ledger events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
      BEGIN SELECT RAISE(ABORT, 'ledger events are append-only'); END;
  `);
}

export function insertEvent(db: Db, e: Envelope): void {
  const values: SqlValue[] = COLUMNS.map((c) => (e[c] ?? null) as SqlValue);
  values.push(JSON.stringify(e.data ?? {}), e.blobs ? JSON.stringify(e.blobs) : null);
  const placeholders = Array(COLUMNS.length + 2)
    .fill("?")
    .join(", ");
  db.prepare(
    `INSERT INTO events (${COLUMNS.join(", ")}, data, blobs) VALUES (${placeholders})`,
  ).run(...values);
}

export function rowToEvent(row: Record<string, unknown>): StoredEvent {
  const e: Record<string, unknown> = {};
  for (const c of COLUMNS) if (row[c] !== null && row[c] !== undefined) e[c] = row[c];
  e.data = JSON.parse(row.data as string);
  if (row.blobs) e.blobs = JSON.parse(row.blobs as string);
  return parseStoredEvent(e);
}

export type ReadFilter = {
  run_id?: string;
  unit_id?: string;
  types?: string[];
  /** Only events with an id greater than this. */
  after?: string;
  limit?: number;
};

export function readEvents(db: Db, f: ReadFilter = {}): StoredEvent[] {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (f.run_id) where.push("run_id = ?") && params.push(f.run_id);
  if (f.unit_id) where.push("unit_id = ?") && params.push(f.unit_id);
  if (f.types?.length) {
    where.push(`type IN (${f.types.map(() => "?").join(", ")})`);
    params.push(...f.types);
  }
  if (f.after) where.push("id > ?") && params.push(f.after);
  const sql = [
    "SELECT * FROM events",
    where.length ? `WHERE ${where.join(" AND ")}` : "",
    "ORDER BY id",
    f.limit ? `LIMIT ${Math.trunc(f.limit)}` : "",
  ].join(" ");
  return db
    .prepare(sql)
    .all(...params)
    .map(rowToEvent);
}
