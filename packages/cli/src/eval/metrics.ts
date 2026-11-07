// What one eval run measured, read from its throwaway ledger.
import type { Ledger } from "@hephaestus/ledger";

export type RunMetrics = {
  /** Whether the planner's first answer was valid; null when it never answered. */
  first_pass_valid: boolean | null;
  units: number;
  attempts: number;
  attempts_per_unit: number;
  escalations: number;
  stalls: number;
  /** Red `diff_scope` gate results. */
  scope_violations: number;
  tokens: number;
  wall_ms: number;
};

const validity = (answer: { outcome?: string } | undefined): boolean | null =>
  !answer || answer.outcome === "escalated" ? null : answer.outcome === "valid";

export function extractMetrics(ledger: Ledger, runId: string, wallMs: number): RunMetrics {
  const events = ledger.read({ run_id: runId }).map((s) => s.event);
  const count = (type: string) => events.filter((e) => e.type === type).length;
  const first = events.find((e) => e.type === "plan.answer");
  const units = ledger.units(runId).length;
  const attempts = ledger.attempts(runId);
  return {
    // An honest escalation is no plan at all, so it says nothing about plan validity.
    first_pass_valid: validity(first?.data as { outcome?: string } | undefined),
    units,
    attempts: attempts.length,
    attempts_per_unit: units ? attempts.length / units : 0,
    escalations: count("unit.escalated"),
    stalls: count("unit.stalled"),
    scope_violations: events.filter((e) => {
      if (e.type !== "gate.result") return false;
      const d = e.data as { gate?: string; verdict?: string };
      return d.gate === "diff_scope" && d.verdict === "fail";
    }).length,
    tokens: attempts.reduce((n, a) => n + (a.input ?? 0) + (a.output ?? 0), 0),
    wall_ms: wallMs,
  };
}
