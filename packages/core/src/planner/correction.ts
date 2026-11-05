import type { Evaluation } from "./evaluate.ts";

export type AnswerOutcome = "valid" | "invalid" | "escalated";

export const answerOutcome = (ev: Evaluation): AnswerOutcome =>
  ev.escalate ? "escalated" : ev.valid ? "valid" : "invalid";

/** One planned run: the first answer and, when it was invalid, the one correction. */
export type CorrectionRecord = {
  first: AnswerOutcome;
  second?: AnswerOutcome;
  /** Failure names of the first answer that the correction cleared / new ones it introduced. */
  fixed?: string[];
  introduced?: string[];
};

const rate = (n: number, d: number) => (d ? n / d : null);
const tally = (names: string[]) => {
  const m: Record<string, number> = {};
  for (const n of names) m[n] = (m[n] ?? 0) + 1;
  return m;
};

/**
 * First-try vs second-try validity (SPEC section 2 correction edge). Escalations are honest
 * exits, not failures: they leave the denominators of the validity rates.
 */
export function correctionStats(records: CorrectionRecord[]) {
  const escalatedFirst = records.filter((r) => r.first === "escalated").length;
  const firstValid = records.filter((r) => r.first === "valid").length;
  const corrected = records.filter((r) => r.first === "invalid");
  const secondValid = corrected.filter((r) => r.second === "valid").length;
  const secondEscalated = corrected.filter((r) => r.second === "escalated").length;
  const planned = records.length - escalatedFirst;
  return {
    runs: records.length,
    escalated_first: escalatedFirst,
    first_try_valid: firstValid,
    first_try_failures: corrected.length,
    second_try_valid: secondValid,
    second_try_escalated: secondEscalated,
    overall_valid: firstValid + secondValid,
    first_try_validity: rate(firstValid, planned),
    second_try_validity: rate(secondValid, corrected.length),
    overall_validity: rate(firstValid + secondValid, planned),
    fixed_by_correction: tally(corrected.flatMap((r) => r.fixed ?? [])),
    introduced_by_correction: tally(corrected.flatMap((r) => r.introduced ?? [])),
  };
}
