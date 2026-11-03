import type { z } from "zod";
import { runPlanGates } from "../gates/plan.ts";
import type { GateContext, GateResult } from "../gates/types.ts";
import { Escalation, Plan } from "../schemas/plan.ts";

/** Failure buckets that come before the plan gates can run. */
export type PreGateFailure = "json_parse" | "schema";

export type Evaluation = {
  valid: boolean;
  /** Pre-gate buckets and names of failed gates, for the histogram. */
  failures: string[];
  error?: string;
  plan?: Plan;
  /** Set when the planner escalated instead of planning; not a failure. */
  escalate?: string[];
  gates: GateResult[];
};

const schemaFailure = (error: z.ZodError): Evaluation => ({
  valid: false,
  failures: ["schema"],
  error: error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
  gates: [],
});

/** Accepts bare JSON, a fenced block, or JSON surrounded by stray prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(trimmed)?.[1];
  const candidate = fenced ?? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

/** Removes object keys whose value is null, at any depth; nulls inside arrays stay. */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, dropNulls(v)]),
    );
  }
  return value;
}

/**
 * The engine stamps `brief_hash`; whatever the planner wrote there is overwritten. Null-valued
 * fields are dropped first, so a placeholder like `"context_budget": null` reads as absent.
 */
export function evaluatePlannerOutput(
  text: string,
  ctx: GateContext,
  briefHash: string,
): Evaluation {
  let raw: unknown;
  try {
    raw = dropNulls(extractJson(text));
  } catch (e) {
    return { valid: false, failures: ["json_parse"], error: String(e), gates: [] };
  }

  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    // An object without tasks that says escalate is an Escalation; anything else is a Plan.
    if ("escalate" in raw && !("tasks" in raw)) {
      const escalation = Escalation.safeParse(raw);
      if (!escalation.success) return schemaFailure(escalation.error);
      return { valid: false, failures: [], escalate: escalation.data.escalate, gates: [] };
    }
    raw = { ...raw, brief_hash: briefHash };
  }
  const parsed = Plan.safeParse(raw);
  if (!parsed.success) return schemaFailure(parsed.error);

  const plan = parsed.data;
  const gates = runPlanGates(plan, ctx);
  const failures = gates.filter((g) => g.verdict === "fail").map((g) => g.gate);
  return { valid: failures.length === 0, failures, plan, gates };
}
