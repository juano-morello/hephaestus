import type { Db } from "../db.ts";

/** Bump when a table or reducer changes; open() then rebuilds every projection from events. */
export const PROJECTION_VERSION = 2;

const TABLES = ["runs", "units", "attempts", "gate_stats", "usage"] as const;

export function createProjectionTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      last_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      changeset_id TEXT NOT NULL,
      owner_node TEXT NOT NULL,
      status TEXT NOT NULL,
      eval INTEGER NOT NULL,
      brief_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS units (
      run_id TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      project TEXT,
      kind TEXT,
      lane TEXT,
      complexity TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      last_outcome TEXT,
      PRIMARY KEY (run_id, unit_id)
    );
    CREATE TABLE IF NOT EXISTS attempts (
      run_id TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      role TEXT,
      tier TEXT,
      model TEXT,
      provider TEXT,
      status TEXT NOT NULL,
      outcome TEXT,
      duration_ms INTEGER,
      input INTEGER,
      output INTEGER,
      cache_read INTEGER,
      cache_write INTEGER,
      config_hash TEXT NOT NULL,
      prompt_hash TEXT,
      started_at TEXT,
      finished_at TEXT,
      PRIMARY KEY (run_id, unit_id, attempt)
    );
    CREATE TABLE IF NOT EXISTS gate_stats (
      gate TEXT NOT NULL,
      project TEXT NOT NULL,
      runs INTEGER NOT NULL,
      pass INTEGER NOT NULL,
      fail INTEGER NOT NULL,
      PRIMARY KEY (gate, project)
    );
    CREATE TABLE IF NOT EXISTS usage (
      run_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      eval INTEGER NOT NULL,
      input INTEGER NOT NULL,
      output INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      PRIMARY KEY (run_id, provider, model)
    );
  `);
}

export function dropProjectionTables(db: Db): void {
  for (const t of [...TABLES, "projection_meta"]) db.exec(`DROP TABLE IF EXISTS ${t}`);
}
