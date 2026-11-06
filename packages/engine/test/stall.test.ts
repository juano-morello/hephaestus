import { describe, expect, test } from "bun:test";
import type { LedgerEvent } from "@hephaestus/ledger";
import {
  categorize,
  diagnose,
  diffStat,
  failureDetail,
  isStalled,
  normalizeEvidence,
  stallSignature,
  stuckEvidence,
} from "../src/stall.ts";

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

describe("normalizeEvidence", () => {
  test("timings, cached markers, temp paths and timestamps do not count as a difference", () => {
    const a =
      "ok  \tpkg/pressure\t104.422s\nFAIL x 182.399µs /tmp/heph-ab12/w 2026-11-05T10:00:01Z";
    const b = "ok  \tpkg/pressure\t(cached)\nFAIL x 235ms /tmp/heph-zz99/w 2026-11-05T11:30:59Z";
    expect(normalizeEvidence(a)).toBe(normalizeEvidence(b));
  });
  test("counts stay: 4 bots is not 5 bots", () => {
    expect(normalizeEvidence("Bots = 4, want 5")).not.toBe(normalizeEvidence("Bots = 5, want 5"));
  });
  test("signatures of runs that differ only in timing match", () => {
    const run = (t: string) =>
      reasons({
        gate: "tests",
        reason: "tests must pass here",
        evidence: ["exit 1", `ok pkg ${t}`, "FAIL TestX"],
      });
    expect(stallSignature(run("1.2s"))).toBe(stallSignature(run("(cached)")));
  });
});

describe("diffStat", () => {
  test("counts added and removed lines per file", () => {
    const text = [
      "diff --git a/a.go b/a.go",
      "--- a/a.go",
      "+++ b/a.go",
      "@@ -1,2 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "+newer",
      "diff --git a/b.go b/b.go",
      "--- a/b.go",
      "+++ b/b.go",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    expect(diffStat(text)).toBe("2 files changed, +3 -2: a.go (+2 -1), b.go (+1 -1)");
  });
  test("an empty diff says so", () => {
    expect(diffStat("")).toBe("no changes");
  });
});

describe("stuckEvidence", () => {
  test("keeps the failing lines, not the passing ones, and is short", () => {
    const e = stuckEvidence([
      "exit 1",
      `${"ok  \tpkg/a\t1s\n".repeat(50)}--- FAIL: TestBots\n    runner_test.go:92: Bots = 4, want 5`,
    ]);
    expect(e).toContain("FAIL: TestBots");
    expect(e).toContain("Bots = 4, want 5");
    expect(e).not.toContain("pkg/a");
    expect(e.length).toBeLessThan(500);
  });
});

describe("categorize", () => {
  test("scope, locked, path, infra", () => {
    const c = (gate: string, ...evidence: string[]) =>
      categorize({ gate, reason: "r", evidence }).category;
    expect(c("diff_scope", "out of scope: README.md")).toBe("scope conflict");
    expect(c("locked_paths", "modified locked file: a_test.go")).toBe("locked-test conflict");
    expect(c("tests", "exit 1", "open fixtures/x.json: no such file or directory")).toBe(
      "path mismatch",
    );
    expect(c("tests", "exit 1", "dial tcp: connection refused")).toBe("flaky infra");
    expect(c("tests", "exit 1", "assertion failed")).toBe("other");
  });
  test("a suggestion is always given", () => {
    expect(categorize({ gate: "diff_scope", reason: "r", evidence: [] }).suggestion).toContain(
      "--scope",
    );
  });
});

describe("diagnose", () => {
  const fin = (unit: string, attempt: number, outcome: string, diff?: string) =>
    ({
      type: "unit.attempt.finished",
      unit_id: unit,
      attempt,
      data: { outcome },
      blobs: diff ? { diff } : undefined,
    }) as unknown as LedgerEvent;
  const stalledEv = (unit: string) =>
    ({ type: "unit.stalled", unit_id: unit, data: { attempts: [1, 2] } }) as unknown as LedgerEvent;
  const scope = {
    gate: "diff_scope",
    reason: "changes outside the task scope",
    evidence: ["out of scope: README.md"],
  };
  test("names the repeating gate, evidence, what each attempt changed and a hint category", () => {
    const events = [
      fin("T1", 1, "red", "d1"),
      returned("T1", 1, scope),
      fin("T1", 2, "red", "d2"),
      returned("T1", 2, scope),
      stalledEv("T1"),
    ];
    const blobs: Record<string, string> = {
      d1: "diff --git a/README.md b/README.md\n+++ b/README.md\n+hi",
      d2: "diff --git a/README.md b/README.md\n+++ b/README.md\n+hi\n+there",
    };
    const d = diagnose(events, "T1", (id) => blobs[id]);
    expect(d?.gate).toBe("diff_scope");
    expect(d?.repeated).toBe(2);
    expect(d?.evidence).toEqual(["out of scope: README.md"]);
    expect(d?.attempts.map((a) => a.changed)).toEqual([
      "1 file changed, +1 -0: README.md (+1 -0)",
      "1 file changed, +2 -0: README.md (+2 -0)",
    ]);
    expect(d?.category).toBe("scope conflict");
  });
  test("undefined for a unit that never failed", () => {
    expect(diagnose([fin("T1", 1, "green")], "T1", () => undefined)).toBeUndefined();
  });
});
