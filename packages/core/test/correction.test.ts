import { describe, expect, test } from "bun:test";
import { answerOutcome, correctionStats } from "../src/planner/correction.ts";

describe("correctionStats", () => {
  test("first-try, second-try and overall validity", () => {
    const s = correctionStats([
      { first: "valid" },
      { first: "valid" },
      { first: "invalid", second: "valid", fixed: ["criteria_covered"], introduced: [] },
      { first: "invalid", second: "invalid", fixed: [], introduced: ["scope"] },
      { first: "invalid", second: "escalated" },
      { first: "escalated" },
    ]);
    expect(s).toMatchObject({
      runs: 6,
      first_try_valid: 2,
      first_try_failures: 3,
      second_try_valid: 1,
      second_try_escalated: 1,
      escalated_first: 1,
      overall_valid: 3,
    });
    expect(s.first_try_validity).toBeCloseTo(2 / 5);
    expect(s.second_try_validity).toBeCloseTo(1 / 3);
    expect(s.overall_validity).toBeCloseTo(3 / 5);
    expect(s.introduced_by_correction).toEqual({ scope: 1 });
    expect(s.fixed_by_correction).toEqual({ criteria_covered: 1 });
  });

  test("no failures means no second-try rate, not zero", () => {
    const s = correctionStats([{ first: "valid" }]);
    expect(s.second_try_validity).toBeNull();
    expect(s.first_try_validity).toBe(1);
  });

  test("answerOutcome maps an Evaluation", () => {
    expect(answerOutcome({ valid: true, failures: [], gates: [] })).toBe("valid");
    expect(answerOutcome({ valid: false, failures: ["x"], gates: [] })).toBe("invalid");
    expect(answerOutcome({ valid: false, failures: [], escalate: ["r"], gates: [] })).toBe(
      "escalated",
    );
  });
});
