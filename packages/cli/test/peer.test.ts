import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "@hephaestus/ledger";
import { processTransport, syncWith } from "@hephaestus/node";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("heph peer", () => {
  test("a real heph peer process syncs both ways over its stdio", async () => {
    root = mkdtempSync(join(tmpdir(), "heph-peer-"));
    const homeB = join(root, "denver");
    mkdirSync(homeB);
    writeFileSync(join(homeB, "config.yaml"), "node: { id: denver }\n");
    const b = openLedger(homeB, { nodeId: "denver" });
    const base = { changeset_id: "C1", config_hash: "c", actor: "engine" } as const;
    b.append({
      ...base,
      run_id: "RB",
      type: "run.created",
      data: { owner_node: "denver", brief_hash: "b".repeat(64), eval: false },
    });
    b.close();

    const a = openLedger(join(root, "mbp"), { nodeId: "mbp" });
    a.append({
      ...base,
      run_id: "RA",
      type: "run.created",
      data: { owner_node: "mbp", brief_hash: "a".repeat(64), eval: false },
    });
    const t = processTransport(["bun", MAIN, "peer", "--home", homeB]);
    try {
      expect(await syncWith(a, t)).toEqual({ peer: "denver", pulled: 1, pushed: 1 });
      await expect(t.request("no.such")).rejects.toThrow("unknown method no.such");
      expect(await syncWith(a, t)).toEqual({ peer: "denver", pulled: 0, pushed: 0 });
    } finally {
      await t.close();
    }
    expect(a.runs().map((r) => r.run_id)).toEqual(["RA", "RB"]);
    const b2 = openLedger(homeB, { nodeId: "denver" });
    expect(b2.runs().map((r) => [r.run_id, r.owner_node])).toEqual([
      ["RA", "mbp"],
      ["RB", "denver"],
    ]);
    b2.close();
    a.close();
  }, 30_000);
});
