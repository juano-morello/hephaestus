import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonAt, startDaemon } from "../src/daemon.ts";

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("daemon node sync", () => {
  test("an unreachable node is retried with backoff, logged once, and shown in status", async () => {
    root = mkdtempSync(join(tmpdir(), "heph-dn-"));
    const calls: number[] = [];
    let up = false;
    const host = {
      node: "mbp",
      api: { call: async () => ({ runs: [] }) },
      resumeOnStart: async () => [],
      syncAll: async (only?: (n: string) => boolean) => {
        if (only && !only("denver")) return [];
        calls.push(Date.now());
        return up
          ? [{ node: "denver", ok: true, pulled: 0, pushed: 0 }]
          : [{ node: "denver", ok: false, error: "Connection to UNKNOWN port 65535 timed out" }];
      },
    } as unknown as Parameters<typeof startDaemon>[0];
    const lines: string[] = [];
    const d = await startDaemon(host, { home: root, intervalS: 0.02, log: (l) => lines.push(l) });
    await Bun.sleep(500);
    const client = await daemonAt(root);
    const status = (await client?.call("status", [])) as {
      nodes: Record<string, { ok: boolean; failures: number; error?: string }>;
    };
    expect(status.nodes.denver).toMatchObject({ ok: false });
    expect(status.nodes.denver?.error).toContain("UNKNOWN port 65535");
    // 20, 40, 80, 160 ms ...: far fewer than one try per tick (25 ticks).
    expect(calls.length).toBeLessThan(8);
    expect(lines.filter((l) => l.includes("unreachable since"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("sync with denver failed"))).toHaveLength(0);
    up = true;
    for (let i = 0; i < 100 && !lines.some((l) => l.includes("reachable again")); i++)
      await Bun.sleep(50);
    expect(lines.some((l) => l.includes("reachable again"))).toBe(true);
    await d.stop();
  });
});
