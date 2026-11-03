import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { openLedger } from "../src/ledger.ts";
import { decodeTime } from "../src/ulid.ts";
import { tempDir } from "./helpers.ts";
import { samples } from "./samples.ts";

const dir = tempDir();
const T0 = Date.parse("2026-11-03T20:00:00.000Z");
const open = (d = dir(), now = () => T0) => openLedger(d, { nodeId: "devserver", now });

describe("append", () => {
  test("stamps id, ts, schema and node_id, and reads back the same event", () => {
    const ledger = open();
    const e = ledger.append(samples["run.created"]);
    expect(e.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(decodeTime(e.id)).toBe(T0);
    expect(e).toMatchObject({ ts: "2026-11-03T20:00:00.000Z", schema: 1, node_id: "devserver" });
    expect(ledger.read()).toEqual([{ known: true, event: e }]);
    ledger.close();
  });

  test("ids from one ledger strictly increase in append order", () => {
    const ledger = open();
    const ids = Array.from({ length: 20 }, () => ledger.append(samples["human.input"]).id);
    expect([...ids].sort()).toEqual(ids);
    ledger.close();
  });

  test("rejects an invalid event with its issues and writes nothing", () => {
    const ledger = open();
    const { unit_id: _, ...bad } = samples["unit.attempt.started"];
    expect(() => ledger.append(bad as (typeof samples)["unit.attempt.started"])).toThrow(
      "invalid event: unit_id: required for unit.attempt.started",
    );
    expect(ledger.read()).toEqual([]);
    ledger.close();
  });

  test("a batch is all or nothing", () => {
    const ledger = open();
    const bad = { ...samples["run.finished"], data: { surprise: true } };
    expect(() =>
      ledger.appendMany([
        samples["run.created"],
        bad as unknown as (typeof samples)["run.finished"],
      ]),
    ).toThrow("invalid event");
    expect(ledger.read()).toEqual([]);
    const ok = ledger.appendMany([samples["run.created"], samples["run.finished"]]);
    expect(ok.map((e) => e.type)).toEqual(["run.created", "run.finished"]);
    ledger.close();
  });

  test("blob refs must point at blobs this node has", () => {
    const ledger = open();
    const missing = "d".repeat(64);
    const draft = { ...samples["unit.attempt.finished"], blobs: { diff: missing } };
    expect(() => ledger.append(draft)).toThrow(
      `invalid event: blobs.diff: blob ${missing} is not in the store`,
    );
    const diff = ledger.blobs.put("diff --git a/a.go b/a.go");
    expect(ledger.append({ ...draft, blobs: { diff } }).blobs).toEqual({ diff });
    ledger.close();
  });
});

describe("append-only", () => {
  test("the database itself refuses updates and deletes", () => {
    const d = dir();
    const ledger = open(d);
    ledger.append(samples["run.created"]);
    ledger.close();
    const db = openDb(join(d, "ledger.db"));
    expect(() => db.exec("UPDATE events SET type = 'run.failed'")).toThrow(
      "ledger events are append-only",
    );
    expect(() => db.exec("DELETE FROM events")).toThrow("ledger events are append-only");
    db.close();
    const again = open(d);
    expect(again.read()).toHaveLength(1);
    again.close();
  });
});

describe("read", () => {
  test("filters by run, unit, types and position, in id order", () => {
    const ledger = open();
    const a = ledger.append(samples["run.created"]);
    const b = ledger.append(samples["unit.attempt.started"]);
    const c = ledger.append({ ...samples["unit.attempt.started"], unit_id: "T1" });
    const d = ledger.append({ ...samples["run.created"], run_id: "R2" });
    const ids = (f: Parameters<typeof ledger.read>[0]) => ledger.read(f).map((s) => s.event.id);
    expect(ids({ run_id: "R1" })).toEqual([a.id, b.id, c.id]);
    expect(ids({ run_id: "R1", unit_id: "T1" })).toEqual([c.id]);
    expect(ids({ types: ["run.created"] })).toEqual([a.id, d.id]);
    expect(ids({ after: b.id })).toEqual([c.id, d.id]);
    expect(ids({ limit: 2 })).toEqual([a.id, b.id]);
    ledger.close();
  });

  test("returns events of unknown types written by a newer node", () => {
    const d = dir();
    open(d).close();
    const db = openDb(join(d, "ledger.db"));
    db.prepare(
      `INSERT INTO events (id, ts, type, schema, node_id, run_id, changeset_id, actor, config_hash, data)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "01JBX0000000000000000000ZZ",
      "2026-11-03T20:00:00.000Z",
      "run.teleported",
      "mbp",
      "R1",
      "C1",
      "engine",
      "cfg1",
      '{"x":1}',
    );
    db.close();
    const ledger = open(d);
    expect(ledger.read()).toEqual([
      expect.objectContaining({
        known: false,
        event: expect.objectContaining({ type: "run.teleported", data: { x: 1 } }),
      }),
    ]);
    ledger.close();
  });
});

describe("persistence", () => {
  test("reopening keeps events and WAL mode", () => {
    const d = dir();
    const first = open(d);
    const e = first.append(samples["run.created"]);
    first.close();
    const db = openDb(join(d, "ledger.db"));
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    db.close();
    const second = open(d);
    expect(second.read()).toEqual([{ known: true, event: e }]);
    second.close();
  });
});
