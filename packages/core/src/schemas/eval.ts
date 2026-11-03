import { isAbsolute } from "node:path";
import { z } from "zod";

const ProjectPath = z
  .string()
  .min(1)
  .refine((p) => !isAbsolute(p) && !p.split("/").includes(".."), {
    message: "must be a relative path inside the project",
  });

/** Applied after the run and never shown to the harness (SPEC section 14). */
export const Oracle = z
  .object({
    hidden_tests: z
      .array(
        z
          .object({
            project: z.string().min(1),
            /** Relative to the eval task file. */
            from: z.string().min(1),
            /** Relative to the project root in the run's worktree. */
            to: ProjectPath,
          })
          .strict(),
      )
      .min(1),
    must_pass: z
      .array(z.object({ project: z.string().min(1), run: z.string().min(1) }).strict())
      .min(1),
    must_not_touch: z
      .array(
        z.object({ project: z.string().min(1), paths: z.array(z.string().min(1)).min(1) }).strict(),
      )
      .default([]),
  })
  .strict();
export type Oracle = z.infer<typeof Oracle>;

export const EvalTask = z
  .object({
    id: z.string().min(1),
    /** Repo name to pinned commit. */
    workspace_ref: z.record(
      z.string(),
      z.string().regex(/^[0-9a-f]{7,40}$/, "must be a commit sha"),
    ),
    /** Relative to the eval task file. */
    brief: z.string().min(1),
    oracle: Oracle.optional(),
    /** A should-escalate task is solved when the planner returns an Escalation. */
    expect: z.literal("escalate").optional(),
    tags: z.array(z.string()),
  })
  .strict()
  .superRefine((t, ctx) => {
    if ((t.oracle === undefined) === (t.expect === undefined)) {
      ctx.addIssue({ code: "custom", message: "set exactly one of oracle or expect" });
    }
  });
export type EvalTask = z.infer<typeof EvalTask>;
