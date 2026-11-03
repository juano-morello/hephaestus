import { describe, expect, test } from "bun:test";
import { GateResult } from "../src/gates/types.ts";
import { Return } from "../src/schemas/return.ts";

const ret = (): Return => ({
  schema: 1,
  unit_id: "T2",
  attempt: 1,
  verdict: "red",
  reasons: [
    { gate: "tests", reason: "2 tests failed", evidence: "stack_test.go:41 want 50 got 51" },
  ],
  scope: ["internal/inventory/inventory.go"],
  instruction: "fix only the listed failures; do not modify locked paths",
});

describe("Return", () => {
  test("accepts a red return with reasons", () => {
    expect(Return.safeParse(ret()).success).toBe(true);
  });

  test("rejects any verdict but red", () => {
    expect(Return.safeParse({ ...ret(), verdict: "green" }).success).toBe(false);
  });

  test("rejects a return with no reasons or a non-positive attempt", () => {
    expect(Return.safeParse({ ...ret(), reasons: [] }).success).toBe(false);
    expect(Return.safeParse({ ...ret(), attempt: 0 }).success).toBe(false);
  });
});

describe("GateResult", () => {
  test("parses what the gates return", () => {
    const r: GateResult = {
      gate: "size_limits",
      verdict: "fail",
      reason: "too big",
      evidence: ["13 tasks > limit 12"],
    };
    expect(GateResult.parse(r)).toEqual(r);
  });

  test("rejects unknown verdicts and extra fields", () => {
    const r = { gate: "g", verdict: "pass", reason: "ok", evidence: [] };
    expect(GateResult.safeParse({ ...r, verdict: "maybe" }).success).toBe(false);
    expect(GateResult.safeParse({ ...r, score: 1 }).success).toBe(false);
  });
});
