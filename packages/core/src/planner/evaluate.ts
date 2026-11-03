import { runPlanGates } from "../gates/plan.ts";
import type { GateContext, GateResult } from "../gates/types.ts";
import { Plan } from "../schemas/plan.ts";

/** Failure buckets that come before the plan gates can run. */
export type PreGateFailure = "json_parse" | "schema";

export type Evaluation = {
  valid: boolean;
  /** Pre-gate buckets and names of failed gates, for the histogram. */
  failures: string[];
  error?: string;
  plan?: Plan;
  gates: GateResult[];
};

/** Accepts bare JSON, a fenced block, or JSON surrounded by stray prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(trimmed)?.[1];
  const candidate = fenced ?? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

/** The engine stamps `brief_hash`; whatever the planner wrote there is overwritten. */
export function evaluatePlannerOutput(
  text: string,
  ctx: GateContext,
  briefHash: string,
): Evaluation {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (e) {
    return { valid: false, failures: ["json_parse"], error: String(e), gates: [] };
  }

  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    raw = { ...raw, brief_hash: briefHash };
  }
  const parsed = Plan.safeParse(raw);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { valid: false, failures: ["schema"], error, gates: [] };
  }

  const plan = parsed.data;
  const gates = runPlanGates(plan, ctx);
  const failures = gates.filter((g) => g.verdict === "fail").map((g) => g.gate);
  return { valid: failures.length === 0, failures, plan, gates };
}
