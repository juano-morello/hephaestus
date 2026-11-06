import { z } from "zod";

/** Escalation ladder: the complexity tiers plus `top`, which only roles with a `top` route reach. */
export const Rung = z.enum(["trivial", "standard", "complex", "top"]);
export type Rung = z.infer<typeof Rung>;

export const RUNGS: readonly Rung[] = ["trivial", "standard", "complex", "top"];
