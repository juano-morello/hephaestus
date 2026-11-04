import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type EventDraft, type Ledger, openLedger } from "@hephaestus/ledger";
import { PeerError, syncMethods } from "../src/protocol.ts";
import { syncWith } from "../src/sync.ts";
import { localTransport } from "../src/transport.ts";
import { tempDir } from "./helpers.ts";

const dir = tempDir();
const open = (node: string) => openLedger(join(dir(), node), { nodeId: node });
const base = { changeset_id: "C1", config_hash: "cfg", actor: "engine" } as const;
const created = (run: string, owner: string): EventDraft => ({
  ...base,
  run_id: run,
  type: "run.created",
  data: { owner_node: owner, brief_hash: "b".repeat(64), eval: false },
});
const hint = (run: string, text: string): EventDraft => ({
  ...base,
  run_id: run,
  actor: "human",
  type: "human.input",
  data: { kind: "hint", text },
});
const ids = (l: Ledger) =>
  l
    .read()
    .map((s) => s.event.id)
    .sort();

describe("syncWith", () => {
  test("both nodes end with the union of their events, blobs included", async () => {
    const a = open("mbp");
    const b = open("denver");
    a.appendMany([created("RA", "mbp"), hint("RA", "one")]);
    const sha = b.blobs.put("denver transcript");
    b.appendMany([created("RB", "denver"), { ...hint("RB", "two"), blobs: { log: sha } }]);

    expect(await syncWith(a, localTransport(syncMethods(b)))).toEqual({
      peer: "denver",
      pulled: 2,
      pushed: 2,
    });
    expect(ids(a)).toEqual(ids(b));
    expect(a.blobs.getText(sha)).toBe("denver transcript");
    expect(a.run("RB")?.owner_node).toBe("denver");
    expect(b.run("RA")?.owner_node).toBe("mbp");
    a.close();
    b.close();
  });

  test("syncing again moves nothing; new events move once", async () => {
    const a = open("mbp");
    const b = open("denver");
    const t = localTransport(syncMethods(b));
    a.append(created("RA", "mbp"));
    await syncWith(a, t);
    expect(await syncWith(a, t)).toEqual({ peer: "denver", pulled: 0, pushed: 0 });
    a.append(hint("RA", "later"));
    expect(await syncWith(a, t)).toMatchObject({ pulled: 0, pushed: 1 });
    expect(b.read({ run_id: "RA" })).toHaveLength(2);
    a.close();
    b.close();
  });

  test("events reach a third node through the one in between", async () => {
    const a = open("mbp");
    const b = open("denver");
    const c = open("ci");
    a.append(created("RA", "mbp"));
    c.append(created("RC", "ci"));
    await syncWith(a, localTransport(syncMethods(b)));
    await syncWith(c, localTransport(syncMethods(b)));
    await syncWith(a, localTransport(syncMethods(b)));
    for (const l of [a, b, c]) expect(l.runs().map((r) => r.run_id)).toEqual(["RA", "RC"]);
    for (const l of [a, b, c]) l.close();
  });

  test("pulls page by page", async () => {
    const a = open("mbp");
    const b = open("denver");
    b.append(created("RB", "denver"));
    for (let i = 0; i < 6; i++) b.append(hint("RB", `h${i}`));
    expect(await syncWith(a, localTransport(syncMethods(b, { pageSize: 2 })))).toMatchObject({
      pulled: 7,
    });
    expect(ids(a)).toEqual(ids(b));
    expect(a.cursor("denver")).toBe(7);
    a.close();
    b.close();
  });

  test("a peer on another protocol, or claiming this node's id, is refused", async () => {
    const a = open("mbp");
    const twin = open("mbp");
    await expect(syncWith(a, localTransport(syncMethods(twin)))).rejects.toBeInstanceOf(PeerError);
    const old = localTransport({
      hello: () => {
        throw new PeerError("protocol 1 is not supported by old (speaks 0)");
      },
    });
    await expect(syncWith(a, old)).rejects.toThrow("not supported");
    a.close();
    twin.close();
  });
});
