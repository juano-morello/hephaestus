import { z } from "zod";
import { Complexity, Task } from "./plan.ts";
import { Return } from "./return.ts";

/** Worker -> engine (SPEC section 8). The diff is the truth; `touched` is checked against it. */
export const WorkerResult = z
  .object({
    schema: z.literal(1),
    summary: z.string(),
    claims: z.array(z.string()),
    touched: z.array(z.string()),
    notes_for_reviewer: z.string().optional(),
    /** Honest exit: escalates to the user or a replan. */
    blocked: z
      .object({ reason: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
export type WorkerResult = z.infer<typeof WorkerResult>;

const PackFile = z
  .object({
    path: z.string().min(1),
    content: z.string().optional(),
    outline: z.string().optional(),
    why: z.string().min(1),
  })
  .strict()
  .refine((f) => (f.content === undefined) !== (f.outline === undefined), {
    message: "set exactly one of content or outline",
  });

/** Built by code only, never summarized by a model (SPEC section 9). */
export const ContextPack = z
  .object({
    schema: z.literal(1),
    budget_tokens: z.number().int().positive(),
    project: z
      .object({
        name: z.string().min(1),
        stack: z.string().min(1),
        commands: z
          .object({
            test: z.string().optional(),
            typecheck: z.string().optional(),
            lint: z.string().optional(),
          })
          .strict(),
      })
      .strict(),
    conventions: z.string(),
    repo_map: z.string(),
    files: z.array(PackFile),
    contracts: z.array(z.object({ name: z.string().min(1), content: z.string() }).strict()),
    locked: z.array(z.object({ path: z.string().min(1), content: z.string() }).strict()),
    constraints: z.array(z.string()),
    feedback: Return.optional(),
  })
  .strict();
export type ContextPack = z.infer<typeof ContextPack>;

/** Engine -> worker, built by code only (SPEC section 8). */
export const UnitBrief = z
  .object({
    schema: z.literal(1),
    task: Task,
    role: z.string().min(1),
    tier: Complexity,
    context: ContextPack,
    constraints: z.array(z.string()),
    locked_paths: z.array(z.string()),
    feedback: Return.optional(),
    output_schema: z.string().min(1),
  })
  .strict();
export type UnitBrief = z.infer<typeof UnitBrief>;
