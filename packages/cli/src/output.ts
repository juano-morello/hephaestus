// Stable, versioned `--json` payloads (SPEC section 16): the `data` of each command's envelope.
// Changing a shape incompatibly means bumping JSON_SCHEMA in main.ts.
import { z } from "zod";

const RunStatus = z.enum([
  "created",
  "planned",
  "escalated",
  "paused",
  "running",
  "built",
  "staged",
  "finished",
  "failed",
]);

const TaskSummary = z
  .object({
    id: z.string(),
    title: z.string(),
    kind: z.string(),
    project: z.string(),
    lane: z.string(),
    complexity: z.string(),
  })
  .strict();

export const PlanResult = z
  .object({
    run_id: z.string(),
    status: z.enum(["planned", "escalated", "failed"]),
    plan_id: z.string().optional(),
    tasks: z.array(TaskSummary).optional(),
    escalate: z.array(z.string()).optional(),
    reason: z.string().optional(),
    planner_attempts: z.int().positive(),
  })
  .strict();

export const PlanShow = z
  .object({
    run_id: z.string(),
    plan_id: z.string(),
    approved: z.boolean(),
    order: z.array(z.string()),
    tasks: z.array(TaskSummary),
    risks: z.array(z.string()),
  })
  .strict();

export const Approved = z
  .object({ run_id: z.string(), target: z.enum(["plan", "merge"]), plan_id: z.string().optional() })
  .strict();

export const RunResult = z
  .object({
    run_id: z.string(),
    status: z.enum(["built", "paused", "staged", "landed", "cancelled"]),
    heads: z.record(z.string(), z.string()),
    prs: z.record(z.string(), z.string()).optional(),
    reason: z.string().optional(),
    /** When the run waited out a rate limit before continuing. */
    waited_until: z.iso.datetime().optional(),
  })
  .strict();

const RunRow = z.object({ run_id: z.string(), status: RunStatus }).passthrough();

export const StatusList = z.object({ runs: z.array(RunRow) }).strict();
export const StatusOne = z
  .object({
    run: RunRow,
    plan_approved: z.boolean(),
    units: z.array(
      z.object({ unit_id: z.string(), status: z.string(), attempts: z.int() }).passthrough(),
    ),
    attempts: z.array(
      z.object({ unit_id: z.string(), attempt: z.int(), status: z.string() }).passthrough(),
    ),
    usage: z.array(z.object({ provider: z.string(), model: z.string() }).passthrough()),
    prs: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const Explain = z
  .object({
    run_id: z.string(),
    unit: z.string().optional(),
    events: z.array(
      z
        .object({
          id: z.string(),
          ts: z.string(),
          type: z.string(),
          unit_id: z.string().optional(),
          attempt: z.int().optional(),
          summary: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export const Hint = z
  .object({ run_id: z.string(), unit: z.string(), recorded: z.array(z.string()) })
  .strict();
export const Cancelled = z.object({ run_id: z.string(), status: z.literal("failed") }).strict();
export const MergeResult = z
  .object({ run_id: z.string(), result: z.object({ status: z.string() }).passthrough() })
  .strict();

/** Command name -> schema of its `data`. Every command registered in main.ts appears here. */
export const OUTPUT = {
  init: z.object({ workspaceDir: z.string(), written: z.array(z.string()) }).passthrough(),
  "config explain": z
    .object({ config: z.object({}).passthrough(), sources: z.record(z.string(), z.string()) })
    .strict(),
  new: PlanResult,
  "new feature": PlanResult,
  "plan show": PlanShow,
  "plan revise": PlanResult,
  "approve plan": Approved,
  "approve merge": MergeResult,
  run: RunResult,
  status: z.union([StatusOne, StatusList]),
  explain: Explain,
  hint: Hint,
  cancel: Cancelled,
  "merge status": MergeResult,
} as const;
