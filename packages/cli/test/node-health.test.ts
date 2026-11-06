import { describe, expect, test } from "bun:test";
import { createNodeHealth } from "../src/node-health.ts";

const T0 = Date.parse("2026-01-01T00:00:00Z");

describe("node health", () => {
  test("backs off exponentially, capped, and resets on success", () => {
    let now = T0;
    const h = createNodeHealth({ intervalS: 10, maxBackoffS: 60, now: () => now });
    expect(h.due("denver")).toBe(true);
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      h.record("denver", { ok: false, error: "boom" });
      const s = h.snapshot().denver;
      waits.push(Date.parse(s?.next_try_at ?? "") - now);
      now = Date.parse(s?.next_try_at ?? "");
    }
    expect(waits).toEqual([10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(h.due("denver")).toBe(true);
    h.record("denver", { ok: false, error: "boom" });
    expect(h.due("denver")).toBe(false);
    h.record("denver", { ok: true });
    expect(h.due("denver")).toBe(true);
    expect(h.snapshot().denver).toMatchObject({ ok: true, failures: 0 });
  });

  test("logs once per outage, again only when the error changes, and on recovery", () => {
    let now = T0;
    const lines: string[] = [];
    const h = createNodeHealth({ intervalS: 10, now: () => now, log: (l) => lines.push(l) });
    h.record("denver", { ok: false, error: "ssh: timed out\nmore detail" });
    now += 10_000;
    h.record("denver", { ok: false, error: "ssh: timed out\nmore detail" });
    h.record("denver", { ok: false, error: "ssh: timed out\nmore detail" });
    expect(lines).toEqual([
      "node denver unreachable since 2026-01-01T00:00:00.000Z: ssh: timed out (retrying with backoff; heph doctor explains)",
    ]);
    h.record("denver", { ok: false, error: "Permission denied" });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Permission denied");
    expect(lines[1]).toContain("since 2026-01-01T00:00:00.000Z");
    now += 60_000;
    h.record("denver", { ok: true });
    expect(lines.at(-1)).toBe(
      "node denver reachable again (was unreachable since 2026-01-01T00:00:00.000Z)",
    );
    h.record("denver", { ok: true });
    expect(lines).toHaveLength(3);
  });
});
