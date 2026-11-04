import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Ledger, NotOwnerError, openLedger } from "../src/ledger.ts";
import { tempDir } from "./helpers.ts";
import { samples } from "./samples.ts";

const dir = tempDir();
const open = (node: string) => openLedger(join(dir(), node), { nodeId: node });

/** What a peer sends: every event after a cursor, with the blobs they reference. */
const ship = (from: Ledger, seq = 0) => {
  const batch = from.since(seq);
  const blobs = Object.fromEntries(
    batch.events
      .flatMap((e) => Object.values(e.blobs ?? {}))
      .filter((sha): sha is string => !!sha)
      .map((sha) => [sha, from.blobs.get(sha)]),
  );
  return { ...batch, blobs };
};

describe("since and import", () => {
  test("events cross to another node with their ids, ts and node_id, and land in its projections", () => {
    const a = open("devserver");
    const b = open("mbp");
    const sha = a.blobs.put("transcript text");
    a.appendMany([
      samples["run.created"],
      samples["run.plan_ready"],
      { ...samples["unit.attempt.finished"], blobs: { transcript: sha } },
    ]);
    const batch = ship(a);
    expect(batch.seq).toBe(3);
    expect(b.import(batch.events, batch.blobs)).toBe(3);
    expect(b.read().map((s) => s.event)).toEqual(a.read().map((s) => s.event));
    expect(b.run("R1")).toEqual(a.run("R1"));
    expect(b.units("R1")).toEqual(a.units("R1"));
    expect(b.blobs.getText(sha)).toBe("transcript text");
    a.close();
    b.close();
  });

  test("importing again is a no-op; since pages by local arrival order", () => {
    const a = open("devserver");
    const b = open("mbp");
    a.appendMany([samples["run.created"], samples["run.plan_ready"]]);
    const first = ship(a);
    b.import(first.events, first.blobs);
    expect(b.import(first.events, first.blobs)).toBe(0);
    a.append(samples["run.finished"]);
    const next = ship(a, first.seq);
    expect(next.events.map((e) => e.type)).toEqual(["run.finished"]);
    expect(b.import(next.events, next.blobs)).toBe(1);
    expect(a.since(0, 1).events).toHaveLength(1);
    expect(b.run("R1")?.status).toBe("finished");
    a.close();
    b.close();
  });

  test("an event whose blob is missing, or a blob that doesn't match its id, is refused whole", () => {
    const a = open("devserver");
    const b = open("mbp");
    const sha = a.blobs.put("x");
    a.appendMany([
      samples["run.created"],
      { ...samples["unit.attempt.finished"], blobs: { log: sha } },
    ]);
    const batch = ship(a);
    expect(() => b.import(batch.events, {})).toThrow(`blob ${sha} is not in the store`);
    expect(() => b.import(batch.events, { [sha]: new TextEncoder().encode("y") })).toThrow(
      "does not match",
    );
    expect(b.read()).toEqual([]);
    a.close();
    b.close();
  });

  test("unknown event types from a newer node are kept and passed on", () => {
    const a = open("devserver");
    const b = open("mbp");
    a.append(samples["run.created"]);
    const [created] = ship(a).events;
    const future = {
      ...created,
      id: "01JBX0000000000000000000ZZ",
      type: "run.teleported",
      data: { to: "moon" },
    };
    expect(b.import([created as never, future as never], {})).toBe(2);
    expect(
      b
        .read()
        .map((s) => [s.event.type, s.known])
        .sort(),
    ).toEqual([
      ["run.created", true],
      ["run.teleported", false],
    ]);
    expect(b.since(0).events.map((e) => e.type)).toEqual(["run.created", "run.teleported"]);
    a.close();
    b.close();
  });

  test("cursors per peer are local state", () => {
    const a = open("devserver");
    expect(a.cursor("mbp")).toBe(0);
    a.setCursor("mbp", 7);
    expect(a.cursor("mbp")).toBe(7);
    expect(a.read()).toEqual([]);
    a.close();
  });
});

describe("single writer", () => {
  test("a node can't write events for a run another node owns", () => {
    const a = open("devserver");
    const b = open("mbp");
    a.append(samples["run.created"]);
    const batch = ship(a);
    b.import(batch.events, batch.blobs);
    expect(() => b.append(samples["human.input"])).toThrow(NotOwnerError);
    expect(() => b.append(samples["human.input"])).toThrow(
      "run R1 is owned by devserver; mbp can't write its events",
    );
    a.append(samples["human.input"]);
    a.close();
    b.close();
  });

  test("a handoff moves ownership: the old owner stops, the new one writes", () => {
    const a = open("devserver");
    const b = open("mbp");
    a.appendMany([samples["run.created"], { ...samples["run.handed_off"], data: { to: "mbp" } }]);
    expect(() => a.append(samples["human.input"])).toThrow(NotOwnerError);
    const batch = ship(a);
    b.import(batch.events, batch.blobs);
    b.append({ ...samples["run.resumed"], data: { reason: "handoff" } });
    expect(b.run("R1")?.owner_node).toBe("mbp");
    a.close();
    b.close();
  });

  test("adopting takes a run over from an owner that is gone", () => {
    const a = open("devserver");
    const b = open("mbp");
    a.append(samples["run.created"]);
    const batch = ship(a);
    b.import(batch.events, batch.blobs);
    b.append(samples["run.adopted"]);
    b.append(samples["human.input"]);
    expect(b.run("R1")?.owner_node).toBe("mbp");
    a.close();
    b.close();
  });
});
