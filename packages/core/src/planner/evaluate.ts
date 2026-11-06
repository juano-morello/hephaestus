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
  if (!trimmed) throw new Error("the answer is empty");
  // A closed fence, else an unclosed one (the answer was cut after the opening fence).
  const fenced =
    /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(trimmed)?.[1] ??
    /^```(?:json)?\s*\n([\s\S]*)$/.exec(trimmed)?.[1];
  const body = fenced ?? trimmed;
  const start = body.indexOf("{");
  if (start < 0) throw new Error(`no JSON object in the answer (${trimmed.length} chars)`);
  const end = body.lastIndexOf("}");
  const candidate = end > start ? body.slice(start, end + 1) : "";
  try {
    return JSON.parse(candidate);
  } catch (e) {
    if (isOpenObject(body.slice(start))) {
      throw new Error(
        `the answer is truncated: it ends inside the JSON object (${trimmed.length} chars)`,
      );
    }
    throw e;
  }
}

/** True when the text's braces and strings never close, so it was cut off. */
function isOpenObject(s: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return false;
    }
  }
  return depth > 0 || inString;
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
