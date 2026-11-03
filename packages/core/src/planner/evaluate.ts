import { runPlanGates } from "../gates/plan.ts";
import type { GateContext, GateResult } from "../gates/types.ts";
import { Plan } from "../schemas/plan.ts";

/** Failure buckets that come before the plan gates can run. */
export type PreGateFailure = "json_parse" | "schema" | "brief_hash";

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

export function evaluatePlannerOutput(
  text: string,
  ctx: GateContext,
  expectedHash: string,
): Evaluation {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (e) {
    return { valid: false, failures: ["json_parse"], error: String(e), gates: [] };
  }

  const parsed = Plan.safeParse(raw);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { valid: false, failures: ["schema"], error, gates: [] };
  }

  const plan = parsed.data;
  const failures: string[] = [];
  let error: string | undefined;
  if (plan.brief_hash !== expectedHash) {
    failures.push("brief_hash");
    error = `brief_hash ${plan.brief_hash} != ${expectedHash}`;
  }
  const gates = runPlanGates(plan, ctx);
  failures.push(...gates.filter((g) => g.verdict === "fail").map((g) => g.gate));
  return { valid: failures.length === 0, failures, ...(error ? { error } : {}), plan, gates };
}
