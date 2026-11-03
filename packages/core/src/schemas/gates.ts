import { z } from "zod";

/** Gate names configured per project, from resolved config (SPEC sections 5 and 11). */
export const ProjectGates = z.record(z.string(), z.array(z.string().min(1)));
export type ProjectGates = z.infer<typeof ProjectGates>;
