import { createHash } from "node:crypto";
import { z } from "zod";

export const Criterion = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    kind: z.enum(["behavior", "nonfunctional"]),
    /** Omitted: checked by a test task. Set: checked by that gate instead. */
    check: z
      .object({ gate: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
export type Criterion = z.infer<typeof Criterion>;

// Emptiness of acceptance and open_questions is checked by the brief gate, not the schema,
// so the failure comes back with evidence instead of a parse error.
export const Brief = z
  .object({
    schema: z.literal(1),
    goal: z.string().min(1),
    context: z.string(),
    decisions: z.array(z.string()),
    constraints: z.array(z.string()),
    acceptance: z.array(Criterion),
    out_of_scope: z.array(z.string()),
    known_paths: z
      .array(z.object({ project: z.string().min(1), paths: z.array(z.string()) }).strict())
      .optional(),
    open_questions: z.array(z.string()),
    source: z.enum(["claude-code", "codex", "cli", "omp"]),
  })
  .strict();
export type Brief = z.infer<typeof Brief>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** sha256 of the Brief as sorted-key JSON, so key order never changes the hash. */
export function briefHash(brief: Brief): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(brief)))
    .digest("hex");
}
