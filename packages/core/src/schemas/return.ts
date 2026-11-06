import { z } from "zod";

/** Gate failure sent back to the producer for its next attempt (SPEC section 8). */
export const Return = z
  .object({
    schema: z.literal(1),
    unit_id: z.string().min(1),
    attempt: z.number().int().positive(),
    verdict: z.literal("red"),
    reasons: z
      .array(
        z
          .object({
            gate: z.string().min(1),
            reason: z.string().min(1),
            evidence: z.array(z.string()),
          })
          .strict(),
      )
      .min(1),
    /** Narrowed, usually the failing files. */
    scope: z.array(z.string().min(1)),
    instruction: z.string().min(1),
    /** What the failed attempt changed (files, +/- lines), so the next one need not rediscover it. */
    diff_stat: z.string().optional(),
  })
  .strict();
export type Return = z.infer<typeof Return>;
