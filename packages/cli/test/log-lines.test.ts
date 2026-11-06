import { describe, expect, test } from "bun:test";
import { daemonLine } from "../src/main.ts";
import { describeForLog } from "../src/runtime.ts";

const output = Array.from({ length: 60 }, (_, i) => `push_error trace line ${i}`).join("\n");

describe("daemon log lines", () => {
  test("a failing gate logs a bounded tail, marked as captured output, with a pointer", () => {
    const text = describeForLog(
      {
        type: "gate.result",
        unit_id: "T1",
        attempt: 2,
        data: {
          gate: "tests",
          verdict: "fail",
          reason: "tests failed",
          evidence: ["exit 1", output],
        },
      },
      "R1",
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("tests fail: tests failed (exit 1)");
    const captured = lines.filter((l) => l.startsWith("  | "));
    expect(captured.length).toBeLessThanOrEqual(8);
    expect(captured.at(-1)).toBe("  | push_error trace line 59");
    expect(text).not.toContain("trace line 0\n");
    expect(text).toContain("54 earlier lines");
    expect(text).toContain("heph explain R1 T1");
  });

  test("long lines and long hint text are truncated", () => {
    const long = "x".repeat(5000);
    const hint = describeForLog({ type: "human.input", data: { kind: "hint", text: long } }, "R1");
    expect(hint.length).toBeLessThan(400);
    expect(hint).toContain("truncated");
    const gate = describeForLog(
      {
        type: "gate.result",
        data: { gate: "lint", verdict: "fail", reason: long, evidence: ["exit 2", long] },
      },
      "R1",
    );
    expect(Math.max(...gate.split("\n").map((l) => l.length))).toBeLessThan(400);
  });

  test("a passing gate stays one line", () => {
    expect(
      describeForLog(
        {
          type: "gate.result",
          data: { gate: "lint", verdict: "pass", reason: "lint passed", evidence: ["exit 0"] },
        },
        "R1",
      ),
    ).toBe("lint pass: lint passed (exit 0)");
  });

  test("every physical line gets the timestamp and heph prefix", () => {
    const out = daemonLine("run R1 T1 tests fail\n  | boom", new Date("2026-01-01T00:00:00Z"));
    expect(out).toBe(
      "2026-01-01T00:00:00.000Z heph daemon: run R1 T1 tests fail\n2026-01-01T00:00:00.000Z heph daemon:   | boom\n",
    );
  });
});
