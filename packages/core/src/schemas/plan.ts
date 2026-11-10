import { z } from "zod";

export const TaskKind = z.enum(["test", "implement", "codegen", "docs", "migration"]);
export type TaskKind = z.infer<typeof TaskKind>;

export const Lane = z.enum(["contained", "wide", "irreversible"]);
export type Lane = z.infer<typeof Lane>;

export const Complexity = z.enum(["trivial", "standard", "complex"]);
export type Complexity = z.infer<typeof Complexity>;

export const Task = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    kind: TaskKind,
    project: z.string().min(1),
    lane: Lane,
    complexity: Complexity,
    complexity_reason: z.string().min(1),
    scope: z.array(z.string().min(1)),
    /** Files this task adds, as literal project-relative paths inside its scope. */
    creates: z
      .array(
        z
          .string()
          .min(1)
          .refine((p) => !/[*?[{]/.test(p), "creates takes literal paths, no globs"),
      )
      .optional(),
    covers: z.array(z.string()),
    produces: z.array(z.string().min(1)).optional(),
    consumes: z.array(z.string().min(1)).optional(),
    context_budget: z
      .object({ tokens: z.number().int().positive(), reason: z.string().min(1) })
      .strict()
      .optional(),
    spec: z.string().min(1),
    /**
     * What a `test` task leaves the suite as: "red" (the default) for tests of behavior that does
     * not exist yet, "green" for characterization tests and tests that pin a refactor, which
     * already pass.
     */
    expect: z.enum(["red", "green"]).optional(),
  })
  .strict();
export type Task = z.infer<typeof Task>;

export const Plan = z
  .object({
    schema: z.literal(1),
    brief_hash: z.string().min(1),
    tasks: z.array(Task),
    risks: z.array(z.string()),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    plan.tasks.forEach((t, i) => {
      if (seen.has(t.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", i, "id"],
          message: `duplicate task id "${t.id}"`,
        });
      }
      seen.add(t.id);
    });
  });
export type Plan = z.infer<typeof Plan>;

/** The planner's honest exit: the Brief goes back to its author with these reasons. */
export const Escalation = z
  .object({
    schema: z.literal(1),
    escalate: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type Escalation = z.infer<typeof Escalation>;
