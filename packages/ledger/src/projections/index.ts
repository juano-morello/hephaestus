import type { Db } from "../db.ts";
import { rowToEvent } from "../store.ts";
import { applyEvent } from "./apply.ts";
import { createProjectionTables, dropProjectionTables, PROJECTION_VERSION } from "./schema.ts";

export type RunRow = {
  run_id: string;
  changeset_id: string;
  owner_node: string;
  status:
    | "created"
    | "planned"
    | "escalated"
    | "paused"
    | "running"
    | "built"
    | "staged"
    | "finished"
    | "failed";
  eval: boolean;
  brief_hash: string;
  stack_on: string | null;
  created_at: string;
  updated_at: string;
};
export type UnitRow = {
  run_id: string;
  unit_id: string;
  project: string | null;
  kind: string | null;
  lane: string | null;
  complexity: string | null;
  status: "pending" | "running" | "returned" | "accepted" | "escalated" | "needs_input";
  attempts: number;
  last_outcome: string | null;
};
export type AttemptRow = {
  run_id: string;
  unit_id: string;
  attempt: number;
  role: string | null;
  tier: string | null;
  model: string | null;
  provider: string | null;
  status: "running" | "finished" | "interrupted";
  outcome: string | null;
  duration_ms: number | null;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  config_hash: string;
  prompt_hash: string | null;
  started_at: string | null;
  finished_at: string | null;
};
export type GateStatRow = {
  gate: string;
  project: string;
  runs: number;
  pass: number;
  fail: number;
};
export type UsageRow = {
  run_id: string;
  provider: string;
  model: string;
  eval: boolean;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  attempts: number;
};

/** Applies every event after the cursor, in local arrival order (seq). */
function catchUp(db: Db): void {
  const meta = db
    .prepare("SELECT last_seq FROM projection_meta WHERE id = 1")
    .get<{ last_seq: number }>();
  const rows = db
    .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq")
    .all<Record<string, unknown>>(meta?.last_seq ?? 0);
  for (const row of rows) {
    const stored = rowToEvent(row);
    if (stored.known) applyEvent(db, stored.event);
  }
  const last = rows.at(-1)?.seq;
  if (last !== undefined)
    db.prepare("UPDATE projection_meta SET last_seq = ? WHERE id = 1").run(last as number);
}

export function rebuildProjections(db: Db): void {
  db.transaction(() => {
    dropProjectionTables(db);
    createProjectionTables(db);
    db.prepare("INSERT INTO projection_meta (id, version, last_seq) VALUES (1, ?, 0)").run(
      PROJECTION_VERSION,
    );
    catchUp(db);
  });
}

/** On open: rebuild if the projection version changed, else apply anything not yet applied. */
export function initProjections(db: Db): void {
  createProjectionTables(db);
  const meta = db
    .prepare("SELECT version FROM projection_meta WHERE id = 1")
    .get<{ version: number }>();
  if (meta?.version !== PROJECTION_VERSION) rebuildProjections(db);
  else db.transaction(() => catchUp(db));
}

/** Called inside the append transaction for each newly inserted event. */
export const projectAppended = catchUp;

const bool = <T extends { eval: number | boolean }>(row: T) => ({
  ...row,
  eval: row.eval === 1 || row.eval === true,
});

export function queries(db: Db) {
  return {
    runs: () =>
      db.prepare("SELECT * FROM runs ORDER BY run_id").all<RunRow>().map(bool) as RunRow[],
    run: (id: string) => {
      const row = db.prepare("SELECT * FROM runs WHERE run_id = ?").get<RunRow>(id);
      return row ? (bool(row) as RunRow) : undefined;
    },
    /** Run ids stacked on this one, oldest first. */
    stackedOn: (runId: string): string[] =>
      db
        .prepare("SELECT run_id FROM runs WHERE stack_on = ? ORDER BY created_at, run_id")
        .all<{ run_id: string }>(runId)
        .map((r) => r.run_id),
    units: (runId: string) =>
      db.prepare("SELECT * FROM units WHERE run_id = ? ORDER BY unit_id").all<UnitRow>(runId),
    attempts: (runId: string, unitId?: string) =>
      unitId
        ? db
            .prepare("SELECT * FROM attempts WHERE run_id = ? AND unit_id = ? ORDER BY attempt")
            .all<AttemptRow>(runId, unitId)
        : db
            .prepare("SELECT * FROM attempts WHERE run_id = ? ORDER BY unit_id, attempt")
            .all<AttemptRow>(runId),
    gateStats: () =>
      db.prepare("SELECT * FROM gate_stats ORDER BY gate, project").all<GateStatRow>(),
    usage: (runId?: string) =>
      (runId
        ? db
            .prepare("SELECT * FROM usage WHERE run_id = ? ORDER BY provider, model")
            .all<UsageRow>(runId)
        : db.prepare("SELECT * FROM usage ORDER BY run_id, provider, model").all<UsageRow>()
      ).map(bool) as UsageRow[],
  };
}
