import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import type { EventDraft } from "../src/events.ts";
import { type Ledger, openLedger } from "../src/ledger.ts";
import { tempDir } from "./helpers.ts";
import { samples } from "./samples.ts";

const dir = tempDir();
let clock = Date.parse("2026-11-03T20:00:00.000Z");
const open = (d: string) => openLedger(d, { nodeId: "devserver", now: () => (clock += 1000) });

const run = (run_id: string) => ({ run_id, changeset_id: `C-${run_id}` });
const attempt = (run_id: string, unit_id: string, n: number) => ({
  ...run(run_id),
  project: "server",
  unit_id,
  attempt: n,
});
const finished = (
  run_id: string,
  unit_id: string,
  n: number,
  outcome: "green" | "red",
  input = 1000,
) =>
  ({
    ...samples["unit.attempt.finished"],
    ...attempt(run_id, unit_id, n),
    data: {
      ...samples["unit.attempt.finished"].data,
      outcome,
      usage: { input, output: 100, cache_read: 0, cache_write: 0 },
    },
  }) satisfies EventDraft<"unit.attempt.finished">;
const gate = (run_id: string, verdict: "pass" | "fail") =>
  ({
    ...samples["gate.result"],
    ...attempt(run_id, "T2", 1),
    data: { gate: "tests", verdict, reason: verdict, evidence: [] },
  }) satisfies EventDraft<"gate.result">;

/** R1: T1 green first try; T2 red, then interrupted, then green. R2: an eval run. */
function script(ledger: Ledger) {
  ledger.appendMany([
    { ...samples["run.created"], ...run("R1") },
    { ...samples["run.plan_ready"], ...run("R1") },
    { ...samples["node.started"], ...run("R1") },
    { ...samples["unit.attempt.started"], ...attempt("R1", "T1", 1) },
    finished("R1", "T1", 1, "green", 500),
    { ...samples["unit.accepted"], ...attempt("R1", "T1", 1) },
    { ...samples["unit.attempt.started"], ...attempt("R1", "T2", 1) },
    finished("R1", "T2", 1, "red"),
    gate("R1", "fail"),
    { ...samples["unit.returned"], ...attempt("R1", "T2", 1) },
    { ...samples["unit.attempt.started"], ...attempt("R1", "T2", 2) },
    { ...samples["unit.attempt.interrupted"], ...attempt("R1", "T2", 2) },
    { ...samples["unit.attempt.started"], ...attempt("R1", "T2", 3) },
    finished("R1", "T2", 3, "green"),
    gate("R1", "pass"),
    { ...samples["unit.accepted"], ...attempt("R1", "T2", 3) },
    { ...samples["merge.staged"], ...run("R1") },
    { ...samples["merge.committed"], ...run("R1") },
    { ...samples["run.finished"], ...run("R1") },
    {
      ...samples["run.created"],
      ...run("R2"),
      data: { ...samples["run.created"].data, eval: true },
    },
    { ...samples["run.plan_ready"], ...run("R2") },
    { ...samples["unit.attempt.started"], ...attempt("R2", "T2", 1) },
    finished("R2", "T2", 1, "red", 3000),
    gate("R2", "fail"),
    { ...samples["run.paused"], ...run("R2") },
  ]);
}

const snapshot = (l: Ledger) => ({
  runs: l.runs(),
  units: l.runs().flatMap((r) => l.units(r.run_id)),
  attempts: l.runs().flatMap((r) => l.attempts(r.run_id)),
  gateStats: l.gateStats(),
  usage: l.usage(),
});

describe("projections", () => {
  test("runs and units follow the lifecycle", () => {
    const ledger = open(dir());
    script(ledger);
    expect(ledger.run("R1")).toMatchObject({
      status: "finished",
      owner_node: "devserver",
      eval: false,
    });
    expect(ledger.run("R2")).toMatchObject({ status: "paused", eval: true });
    expect(ledger.units("R1")).toEqual([
      {
        run_id: "R1",
        unit_id: "T1",
        project: "server",
        kind: "test",
        lane: "contained",
        complexity: "standard",
        status: "accepted",
        attempts: 1,
        last_outcome: "green",
      },
      {
        run_id: "R1",
        unit_id: "T2",
        project: "server",
        kind: "implement",
        lane: "contained",
        complexity: "standard",
        status: "accepted",
        attempts: 2,
        last_outcome: "green",
      },
    ]);
    ledger.close();
  });

  test("interrupted attempts are recorded but not counted", () => {
    const ledger = open(dir());
    script(ledger);
    expect(ledger.attempts("R1", "T2").map((a) => [a.attempt, a.status, a.outcome])).toEqual([
      [1, "finished", "red"],
      [2, "interrupted", null],
      [3, "finished", "green"],
    ]);
    expect(ledger.units("R1").find((u) => u.unit_id === "T2")?.attempts).toBe(2);
    ledger.close();
  });

  test("gate stats exclude eval runs; usage keeps them, flagged", () => {
    const ledger = open(dir());
    script(ledger);
    expect(ledger.gateStats()).toEqual([
      { gate: "tests", project: "server", runs: 2, pass: 1, fail: 1 },
    ]);
    expect(ledger.usage()).toEqual([
      {
        run_id: "R1",
        provider: "claude",
        model: "claude/sonnet",
        eval: false,
        input: 2500,
        output: 300,
        cache_read: 0,
        cache_write: 0,
        attempts: 3,
      },
      {
        run_id: "R2",
        provider: "claude",
        model: "claude/sonnet",
        eval: true,
        input: 3000,
        output: 100,
        cache_read: 0,
        cache_write: 0,
        attempts: 1,
      },
    ]);
    expect(ledger.usage("R2")).toHaveLength(1);
    ledger.close();
  });

  test("a plan escalation and an adoption land on the run", () => {
    const ledger = open(dir());
    ledger.appendMany([
      { ...samples["run.created"], ...run("R3") },
      { ...samples["run.plan_escalated"], ...run("R3") },
    ]);
    expect(ledger.run("R3")?.status).toBe("escalated");
    const mbp = openLedger(dir(), { nodeId: "mbp" });
    mbp.appendMany([
      { ...samples["run.created"], ...run("R4") },
      { ...samples["run.adopted"], ...run("R4") },
    ]);
    expect(mbp.run("R4")?.owner_node).toBe("mbp");
    mbp.close();
    ledger.close();
  });

  test("incremental projections equal a full rebuild, also after reopening", () => {
    const d = dir();
    const ledger = open(d);
    script(ledger);
    const incremental = snapshot(ledger);
    ledger.rebuildProjections();
    expect(snapshot(ledger)).toEqual(incremental);
    ledger.close();
    const reopened = open(d);
    expect(snapshot(reopened)).toEqual(incremental);
    reopened.close();
  });

  test("a projection version change rebuilds on open", () => {
    const d = dir();
    const ledger = open(d);
    script(ledger);
    const before = snapshot(ledger);
    ledger.close();
    const db = openDb(join(d, "ledger.db"));
    db.exec("UPDATE projection_meta SET version = 0; UPDATE runs SET status = 'bogus'");
    db.close();
    const reopened = open(d);
    expect(snapshot(reopened)).toEqual(before);
    reopened.close();
  });

  test("events written without projections are applied on the next open", () => {
    const d = dir();
    const ledger = open(d);
    ledger.append({ ...samples["run.created"], ...run("R1") });
    ledger.close();
    const db = openDb(join(d, "ledger.db"));
    db.prepare(
      `INSERT INTO events (id, ts, type, schema, node_id, run_id, changeset_id, actor, config_hash, data)
       VALUES (?, ?, 'run.finished', 1, 'mbp', 'R1', 'C-R1', 'engine', 'cfg1', '{}')`,
    ).run("7ZZZZZZZZZZZZZZZZZZZZZZZZZ", "2026-11-03T21:00:00.000Z");
    db.close();
    const reopened = open(d);
    expect(reopened.run("R1")?.status).toBe("finished");
    reopened.close();
  });
});
