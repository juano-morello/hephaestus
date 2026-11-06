import { describe, expect, test } from "bun:test";
import type { LedgerEvent } from "@hephaestus/ledger";
import { failureDetail, isStalled, stallSignature } from "../src/stall.ts";

type R = { gate: string; reason: string; evidence?: string[] };
const reasons = (...rs: R[]) => ({
  reasons: rs.map((r) => ({ evidence: [], ...r })),
});
const returned = (unit: string, attempt: number, ...rs: R[]) =>
  ({
    type: "unit.returned",
    unit_id: unit,
    attempt,
    data: { verdict: "red", ...reasons(...rs) },
  }) as unknown as LedgerEvent;
const ev = (type: string, unit_id?: string) =>
  ({ type, unit_id, data: {} }) as unknown as LedgerEvent;
const fail = { gate: "tests", reason: "1 failed", evidence: ["a_test.go:12"] };

describe("stallSignature", () => {
  test("is the same for the same reasons in any order", () => {
    const a = { gate: "lint", reason: "bad" };
    expect(stallSignature(reasons(fail, a))).toBe(stallSignature(reasons(a, fail)));
  });
  test("differs when the evidence differs", () => {
    expect(stallSignature(reasons(fail))).not.toBe(
      stallSignature(reasons({ ...fail, evidence: ["b_test.go:3"] })),
    );
  });
  test("keeps digits: 63 of 64 is not 62 of 64", () => {
    expect(stallSignature(reasons({ gate: "tests", reason: "63 of 64 passed" }))).not.toBe(
      stallSignature(reasons({ gate: "tests", reason: "62 of 64 passed" })),
    );
  });
});

describe("transport failure evidence", () => {
  const t = (detail: string) => ({
    gate: "worker_output",
    reason: "worker transport failure: timeout",
    evidence: ["kind: timeout", `detail: ${detail}`],
  });
  test("detail lines (timings, counts) do not change the signature", () => {
    expect(stallSignature(reasons(t("hung 20m1s")))).toBe(
      stallSignature(reasons(t("hung 19m58s"))),
    );
  });
  test("but the kind does", () => {
    expect(stallSignature(reasons(t("x")))).not.toBe(
      stallSignature(reasons({ ...t("x"), evidence: ["kind: idle", "detail: x"] })),
    );
  });
  test("failureDetail says why, only when the gate recorded a detail", () => {
    expect(failureDetail(t("hung 20m"))).toBe("worker transport failure: timeout (hung 20m)");
    expect(failureDetail({ gate: "tests", reason: "1 failed", evidence: ["a"] })).toBeUndefined();
  });
});

describe("isStalled", () => {
  test("two identical returns stall", () => {
    const got = isStalled([returned("T1", 1, fail), returned("T1", 2, fail)], "T1");
    expect(got).toEqual({ attempts: [1, 2], signature: stallSignature(reasons(fail)) });
  });
  test("one return, different evidence, or another unit's returns do not", () => {
    expect(isStalled([returned("T1", 1, fail)], "T1")).toBeUndefined();
    expect(
      isStalled([returned("T1", 1, fail), returned("T1", 2, { ...fail, evidence: ["x"] })], "T1"),
    ).toBeUndefined();
    expect(isStalled([returned("T2", 1, fail), returned("T2", 2, fail)], "T1")).toBeUndefined();
  });
  test("spans an escalation", () => {
    const events = [returned("T1", 3, fail), ev("unit.escalated", "T1"), returned("T1", 4, fail)];
    expect(isStalled(events, "T1")?.attempts).toEqual([3, 4]);
  });
  test("a hint for the unit or the whole run resets; a hint for another unit does not", () => {
    for (const unit of ["T1", undefined]) {
      const events = [returned("T1", 1, fail), ev("human.input", unit), returned("T1", 2, fail)];
      expect(isStalled(events, "T1")).toBeUndefined();
      expect(isStalled([...events, returned("T1", 3, fail)], "T1")?.attempts).toEqual([2, 3]);
    }
    const other = [returned("T1", 1, fail), ev("human.input", "T2"), returned("T1", 2, fail)];
    expect(isStalled(other, "T1")?.attempts).toEqual([1, 2]);
  });
});
