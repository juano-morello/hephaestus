import { z } from "zod";

export const Project = z
  .object({
    repo: z.string().min(1),
    path: z.string().min(1),
    stack: z.string().min(1),
    depends_on: z.array(z.string()).optional(),
  })
  .strict();
export type Project = z.infer<typeof Project>;

export const Workspace = z
  .object({
    repos: z.record(z.string(), z.string()),
    projects: z.record(z.string(), Project),
    integration: z
      .object({ gate: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((ws, ctx) => {
    for (const [name, project] of Object.entries(ws.projects)) {
      if (!(project.repo in ws.repos)) {
        ctx.addIssue({
          code: "custom",
          path: ["projects", name, "repo"],
          message: `unknown repo "${project.repo}"`,
        });
      }
      for (const dep of project.depends_on ?? []) {
        if (!(dep in ws.projects)) {
          ctx.addIssue({
            code: "custom",
            path: ["projects", name, "depends_on"],
            message: `unknown project "${dep}"`,
          });
        }
      }
    }
  });
export type Workspace = z.infer<typeof Workspace>;
