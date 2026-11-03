import type { Db } from "../db.ts";
import type { LedgerEvent } from "../events.ts";

const TERMINAL = "('finished', 'failed')";

function setRunStatus(db: Db, e: LedgerEvent, status: string) {
  db.prepare("UPDATE runs SET status = ? WHERE run_id = ?").run(status, e.run_id);
}

function setUnitStatus(db: Db, e: LedgerEvent, status: string) {
  ensureUnit(db, e);
  db.prepare("UPDATE units SET status = ? WHERE run_id = ? AND unit_id = ?").run(
    status,
    e.run_id,
    e.unit_id as string,
  );
}

/** Units normally come from the plan; one seen first in a unit event gets a minimal row. */
function ensureUnit(db: Db, e: LedgerEvent) {
  db.prepare(
    `INSERT OR IGNORE INTO units (run_id, unit_id, project, status, attempts)
     VALUES (?, ?, ?, 'pending', 0)`,
  ).run(e.run_id, e.unit_id as string, e.project ?? null);
}

function ensureAttempt(db: Db, e: LedgerEvent) {
  db.prepare(
    `INSERT OR IGNORE INTO attempts (run_id, unit_id, attempt, status, config_hash, prompt_hash)
     VALUES (?, ?, ?, 'running', ?, ?)`,
  ).run(e.run_id, e.unit_id as string, e.attempt as number, e.config_hash, e.prompt_hash ?? null);
}

const isEvalRun = (db: Db, runId: string) =>
  db.prepare("SELECT eval FROM runs WHERE run_id = ?").get<{ eval: number }>(runId)?.eval === 1;

/** Applies one known event to every projection. Touches projection tables only. */
export function applyEvent(db: Db, e: LedgerEvent): void {
  db.prepare("UPDATE runs SET updated_at = ? WHERE run_id = ?").run(e.ts, e.run_id);

  switch (e.type) {
    case "run.created":
      db.prepare(
        `INSERT OR IGNORE INTO runs
         (run_id, changeset_id, owner_node, status, eval, brief_hash, created_at, updated_at)
         VALUES (?, ?, ?, 'created', ?, ?, ?, ?)`,
      ).run(
        e.run_id,
        e.changeset_id,
        e.data.owner_node,
        e.data.eval ? 1 : 0,
        e.data.brief_hash,
        e.ts,
        e.ts,
      );
      return;
    case "run.plan_ready": {
      setRunStatus(db, e, "planned");
      const insert = db.prepare(
        `INSERT OR IGNORE INTO units (run_id, unit_id, project, kind, lane, complexity, status, attempts)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)`,
      );
      for (const t of e.data.plan.tasks) {
        insert.run(e.run_id, t.id, t.project, t.kind, t.lane, t.complexity);
      }
      return;
    }
    case "run.plan_escalated":
      setRunStatus(db, e, "escalated");
      return;
    case "run.paused":
      setRunStatus(db, e, "paused");
      return;
    case "run.resumed":
      setRunStatus(db, e, "running");
      return;
    case "run.handed_off":
      db.prepare("UPDATE runs SET owner_node = ? WHERE run_id = ?").run(e.data.to, e.run_id);
      return;
    case "run.adopted":
      db.prepare("UPDATE runs SET owner_node = ? WHERE run_id = ?").run(e.node_id, e.run_id);
      return;
    case "run.finished":
      setRunStatus(db, e, "finished");
      return;
    case "run.failed":
      setRunStatus(db, e, "failed");
      return;
    case "node.started":
      db.prepare(
        `UPDATE runs SET status = 'running' WHERE run_id = ? AND status NOT IN ${TERMINAL}`,
      ).run(e.run_id);
      return;
    case "unit.attempt.started":
      ensureAttempt(db, e);
      db.prepare(
        `UPDATE attempts SET role = ?, tier = ?, model = ?, provider = ?, started_at = ?
         WHERE run_id = ? AND unit_id = ? AND attempt = ?`,
      ).run(
        e.data.role,
        e.data.tier,
        e.data.model,
        e.data.provider,
        e.ts,
        e.run_id,
        e.unit_id as string,
        e.attempt as number,
      );
      setUnitStatus(db, e, "running");
      return;
    case "unit.attempt.finished": {
      const { usage: u } = e.data;
      ensureAttempt(db, e);
      db.prepare(
        `UPDATE attempts SET role = ?, tier = ?, model = ?, provider = ?, status = 'finished',
           outcome = ?, duration_ms = ?, input = ?, output = ?, cache_read = ?, cache_write = ?,
           finished_at = ?
         WHERE run_id = ? AND unit_id = ? AND attempt = ?`,
      ).run(
        e.data.role,
        e.data.tier,
        e.data.model,
        e.data.provider,
        e.data.outcome,
        e.data.duration_ms,
        u.input,
        u.output,
        u.cache_read,
        u.cache_write,
        e.ts,
        e.run_id,
        e.unit_id as string,
        e.attempt as number,
      );
      ensureUnit(db, e);
      db.prepare(
        "UPDATE units SET attempts = attempts + 1, last_outcome = ? WHERE run_id = ? AND unit_id = ?",
      ).run(e.data.outcome, e.run_id, e.unit_id as string);
      db.prepare(
        `INSERT INTO usage (run_id, provider, model, eval, input, output, cache_read, cache_write, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (run_id, provider, model) DO UPDATE SET
           input = input + excluded.input, output = output + excluded.output,
           cache_read = cache_read + excluded.cache_read,
           cache_write = cache_write + excluded.cache_write, attempts = attempts + 1`,
      ).run(
        e.run_id,
        e.data.provider,
        e.data.model,
        isEvalRun(db, e.run_id) ? 1 : 0,
        u.input,
        u.output,
        u.cache_read,
        u.cache_write,
      );
      return;
    }
    case "unit.attempt.interrupted":
      ensureAttempt(db, e);
      db.prepare(
        "UPDATE attempts SET status = 'interrupted', finished_at = ? WHERE run_id = ? AND unit_id = ? AND attempt = ?",
      ).run(e.ts, e.run_id, e.unit_id as string, e.attempt as number);
      setUnitStatus(db, e, "pending");
      return;
    case "gate.result":
      if (isEvalRun(db, e.run_id)) return;
      db.prepare(
        `INSERT INTO gate_stats (gate, project, runs, pass, fail) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT (gate, project) DO UPDATE SET
           runs = runs + 1, pass = pass + excluded.pass, fail = fail + excluded.fail`,
      ).run(
        e.data.gate,
        e.project ?? "",
        e.data.verdict === "pass" ? 1 : 0,
        e.data.verdict === "fail" ? 1 : 0,
      );
      return;
    case "unit.returned":
      setUnitStatus(db, e, "returned");
      return;
    case "unit.accepted":
      setUnitStatus(db, e, "accepted");
      return;
    case "unit.escalated":
      setUnitStatus(db, e, "escalated");
      return;
    case "unit.needs_input":
      setUnitStatus(db, e, "needs_input");
      return;
    case "node.finished":
    case "merge.staged":
    case "merge.committed":
    case "merge.aborted":
    case "human.input":
    case "context.pack_built":
      return;
  }
}
