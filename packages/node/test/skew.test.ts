import { describe, expect, test } from "bun:test";
import { openLedger } from "@hephaestus/ledger";
import { buildSkew, syncMethods } from "../src/protocol.ts";
import { hello } from "../src/sync.ts";
import { localTransport } from "../src/transport.ts";
import { tempDir } from "./helpers.ts";

const dir = tempDir();

describe("build skew between nodes", () => {
  test("hello carries the peer's build", async () => {
    const a = openLedger(dir(), { nodeId: "mbp" });
    const b = openLedger(dir(), { nodeId: "denver" });
    const h = await hello(a, localTransport(syncMethods(b, { version: "0.1.0", build: "abc123" })));
    expect(h).toMatchObject({ node: "denver", version: "0.1.0", build: "abc123" });
    a.close();
    b.close();
  });

  test("a peer that does not say its build is not flagged", async () => {
    const a = openLedger(dir(), { nodeId: "mbp" });
    const b = openLedger(dir(), { nodeId: "denver" });
    const h = await hello(a, localTransport(syncMethods(b)));
    expect(h.build).toBeUndefined();
    a.close();
    b.close();
  });

  test("buildSkew names both builds when they differ", () => {
    const msg = buildSkew("abc123", "def456");
    expect(msg).toContain("abc123");
    expect(msg).toContain("def456");
  });

  test("buildSkew is silent for equal, missing or unknown builds", () => {
    expect(buildSkew("abc123", "abc123")).toBeUndefined();
    expect(buildSkew("abc123", undefined)).toBeUndefined();
    expect(buildSkew(undefined, "abc123")).toBeUndefined();
    expect(buildSkew("unknown", "abc123")).toBeUndefined();
    expect(buildSkew("abc123", "unknown")).toBeUndefined();
  });
});
