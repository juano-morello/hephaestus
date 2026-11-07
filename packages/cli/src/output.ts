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
    scope: z.array(z.string()),
    covers: z.array(z.string()),
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
    /** The node that owns the run (SPEC section 7); `new` only. */
    node: z.string().optional(),
    /** How the run was set up, when the user should know (e.g. --stack-on a parent that landed). */
    note: z.string().optional(),
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

const Route = z.object({ model: z.string(), effort: z.string().optional() }).strict();
const Layer = z.enum(["home", "repo", "workspace"]);

/** `heph run --dry-run`: the engine's Preview. */
export const DryRun = z
  .object({
    dry_run: z.literal(true),
    run_id: z.string(),
    parallel: z.number(),
    waves: z.array(z.array(z.string())),
    units: z.array(
      z
        .object({
          id: z.string(),
          project: z.string(),
          kind: z.string(),
          lane: z.string(),
          planner_tier: z.string(),
          start_tier: z.string(),
          score: z.number(),
          reasons: z.array(z.string()),
          role: z.string(),
          route: Route,
          top: Route.optional(),
          fallback: Route.optional(),
          attempt_timeout_ms: z.number().optional(),
          locked_by: z.array(z.string()),
          gates: z.array(z.string()),
        })
        .strict(),
    ),
    prompts: z.array(z.object({ role: z.string(), path: z.string(), layer: Layer }).strict()),
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
    /** The run this one is stacked on (heph new --stack-on), and where that run stands. */
    stack_on: z.object({ run_id: z.string(), status: z.string() }).strict().optional(),
    /** Set when the run's owner could not be reached to refresh it. */
    stale: z.string().optional(),
  })
  .strict();

/** The run page's one read: the run, its latest plan, and what each unit and attempt did. */
export const Dashboard = z
  .object({
    schema: z.literal(1),
    run: RunRow,
    plan_approved: z.boolean(),
    plan: z
      .object({
        units: z.array(
          z
            .object({
              id: z.string(),
              title: z.string(),
              kind: z.string(),
              project: z.string(),
              depends_on: z.array(z.string()),
            })
            .strict(),
        ),
      })
      .strict(),
    units: z.array(
      z
        .object({
          unit_id: z.string(),
          status: z.string(),
          attempts: z.int(),
          /** False for a unit an earlier plan had and the latest plan dropped. */
          in_plan: z.boolean(),
        })
        .strict(),
    ),
    attempts: z.array(
      z
        .object({
          unit_id: z.string(),
          attempt: z.int(),
          status: z.string(),
          model: z.string().optional(),
          provider: z.string().optional(),
          outcome: z.string().optional(),
          duration_ms: z.int().optional(),
          gates: z.array(
            z
              .object({
                gate: z.string(),
                verdict: z.string(),
                reason: z.string(),
                evidence: z.array(z.string()),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    /** Why the run paused, since it last resumed. */
    pauses: z.array(z.string()),
    stack_on: z.object({ run_id: z.string(), status: z.string() }).strict().optional(),
    usage: z.array(z.object({ provider: z.string(), model: z.string() }).passthrough()),
    stale: z.string().optional(),
  })
  .strict();
export type Dashboard = z.infer<typeof Dashboard>;

/** The plan page: every task field and the Brief's criteria with the tasks covering each. */
export const PlanDetail = z
  .object({
    schema: z.literal(1),
    run_id: z.string(),
    plan_id: z.string(),
    approved: z.boolean(),
    tasks: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          kind: z.string(),
          project: z.string(),
          lane: z.string(),
          complexity: z.string(),
          complexity_reason: z.string(),
          scope: z.array(z.string()),
          creates: z.array(z.string()),
          covers: z.array(z.string()),
          produces: z.array(z.string()),
          consumes: z.array(z.string()),
          spec: z.string(),
        })
        .strict(),
    ),
    risks: z.array(z.string()),
    criteria: z.array(
      z
        .object({
          id: z.string(),
          text: z.string(),
          kind: z.string(),
          check: z.string().optional(),
          projects: z.array(z.string()).optional(),
          covered_by: z.array(z.string()),
        })
        .strict(),
    ),
    stale: z.string().optional(),
  })
  .strict();
export type PlanDetail = z.infer<typeof PlanDetail>;

const Tokens = {
  input: z.int().nonnegative(),
  output: z.int().nonnegative(),
  cache_read: z.int().nonnegative(),
  cache_write: z.int().nonnegative(),
};

/** The run page's charts: attempts per unit, tokens by model and role, escalation and stall counts. */
export const RunCharts = z
  .object({
    schema: z.literal(1),
    run_id: z.string(),
    units: z.array(
      z
        .object({
          unit_id: z.string(),
          attempts: z.array(
            z
              .object({
                attempt: z.int(),
                outcome: z.string().optional(),
                tier: z.string().optional(),
                model: z.string().optional(),
                role: z.string().optional(),
                input: z.int().nonnegative(),
                output: z.int().nonnegative(),
                duration_ms: z.int().optional(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    tokens: z.array(z.object({ model: z.string(), role: z.string(), ...Tokens }).strict()),
    escalations: z.int().nonnegative(),
    stalls: z.int().nonnegative(),
    stale: z.string().optional(),
  })
  .strict();
export type RunCharts = z.infer<typeof RunCharts>;

/** The runs page's strip: across every run on this node. */
export const Overview = z
  .object({
    schema: z.literal(1),
    runs: z.array(z.object({ status: z.string(), count: z.int().positive() }).strict()),
    tokens: z.array(z.object({ model: z.string(), ...Tokens }).strict()),
    escalations: z.int().nonnegative(),
    stalls: z.int().nonnegative(),
  })
  .strict();
export type Overview = z.infer<typeof Overview>;

/** heph stats: how many runs reached merge cleanly (SPEC section 18's kill criterion). */
export const Stats = z
  .object({
    schema: z.literal(1),
    since: z.string(),
    counts: z
      .object({
        clean: z.int().nonnegative(),
        assisted: z.int().nonnegative(),
        did_not_merge: z.int().nonnegative(),
        open: z.int().nonnegative(),
      })
      .strict(),
    clean_rate: z.number().min(0).max(1).nullable(),
    below_threshold: z.boolean().nullable(),
    assisted_totals: z
      .object({
        hints: z.int().nonnegative(),
        replans: z.int().nonnegative(),
        escalations: z.int().nonnegative(),
        stalls: z.int().nonnegative(),
      })
      .strict(),
    runs: z
      .array(
        z
          .object({
            run_id: z.string(),
            status: z.string(),
            class: z.enum(["clean", "assisted", "did_not_merge", "open"]),
            reasons: z.array(z.string()),
          })
          .strict(),
      )
      .optional(),
    footer: z.string(),
  })
  .strict();
export type Stats = z.infer<typeof Stats>;

const DiffFile = z
  .object({
    path: z.string(),
    added: z.int().nonnegative(),
    removed: z.int().nonnegative(),
    binary: z.literal(true).optional(),
    renamed_from: z.string().optional(),
  })
  .strict();

/** What a run changed, per unit and project: file names and line counts, never diff text. */
export const DiffSummary = z
  .object({
    schema: z.literal(1),
    run_id: z.string(),
    units: z.array(
      z
        .object({
          unit_id: z.string(),
          project: z.string(),
          attempt: z.int().optional(),
          status: z.enum(["ok", "unavailable"]),
          partial: z.boolean().optional(),
          files: z.array(DiffFile),
          added: z.int().nonnegative(),
          removed: z.int().nonnegative(),
        })
        .strict(),
    ),
    projects: z.array(
      z
        .object({
          project: z.string(),
          files: z.int().nonnegative(),
          added: z.int().nonnegative(),
          removed: z.int().nonnegative(),
        })
        .strict(),
    ),
    stale: z.string().optional(),
  })
  .strict();
export type DiffSummary = z.infer<typeof DiffSummary>;

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
    /** Why each escalated or stalled unit keeps failing (see engine diagnose). */
    diagnoses: z
      .array(
        z
          .object({
            unit_id: z.string(),
            gate: z.string(),
            reason: z.string(),
            repeated: z.int(),
            evidence: z.array(z.string()),
            attempts: z.array(
              z
                .object({
                  attempt: z.int(),
                  outcome: z.string().optional(),
                  changed: z.string().optional(),
                })
                .strict(),
            ),
            category: z.string(),
            suggestion: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/** The events one per line, then for each stuck unit what keeps failing and what hint may help. */
export const explainText = (x: z.infer<typeof Explain>): string => {
  const events = x.events.map(
    (e) =>
      `${e.ts.slice(11, 19)} ${e.unit_id ? `${e.unit_id}${e.attempt ? `/a${e.attempt}` : ""} ` : ""}${e.summary}`,
  );
  const why = (x.diagnoses ?? []).flatMap((d) => [
    "",
    `${d.unit_id} is stuck on ${d.gate} (failed ${d.repeated} time${d.repeated === 1 ? "" : "s"} in a row): ${d.reason}`,
    ...(d.evidence.length
      ? ["  evidence:", ...d.evidence.map((l) => `    ${l.slice(0, 400)}`)]
      : []),
    ...(d.attempts.length
      ? [
          "  attempts:",
          ...d.attempts.map(
            (a) =>
              `    a${a.attempt}${a.outcome ? ` ${a.outcome}` : ""}${a.changed ? `: ${a.changed}` : ""}`,
          ),
        ]
      : []),
    `  hint category: ${d.category}`,
    `  suggested hint: ${d.suggestion}`,
  ]);
  return `${[...events, ...why].join("\n")}\n`;
};

export const Hint = z
  .object({
    run_id: z.string(),
    unit: z.string(),
    recorded: z.array(z.string()),
    /** --scope: what the unit may now change beyond its plan, project-relative. */
    scope: z.array(z.string()).optional(),
  })
  .strict();
export const Cancelled = z.object({ run_id: z.string(), status: z.literal("failed") }).strict();
export const Synced = z
  .object({
    peers: z.array(
      z
        .object({
          node: z.string(),
          ok: z.boolean(),
          pulled: z.int().optional(),
          pushed: z.int().optional(),
          error: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export const HandedOff = z
  .object({ run_id: z.string(), to: z.string(), pushed: z.array(z.string()), dir: z.string() })
  .strict();
export const Adopted = z
  .object({ run_id: z.string(), from: z.string(), fetched: z.array(z.string()) })
  .strict();
export const MergeResult = z
  .object({
    run_id: z.string(),
    result: z.object({ status: z.string() }).passthrough(),
    /** Once the run landed: its staged children, restacked onto the target (or why not). */
    restacked: z
      .record(
        z.string(),
        z
          .object({
            status: z.string(),
            reason: z.string().optional(),
            prs: z.record(z.string(), z.string()).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/** Command name -> schema of its `data`. Every command registered in main.ts appears here. */
export const OUTPUT = {
  init: z.object({ workspaceDir: z.string(), written: z.array(z.string()) }).passthrough(),
  "config explain": z
    .object({
      config: z.object({}).passthrough(),
      sources: z.record(z.string(), z.string()),
      roles: z.array(z.object({ role: z.string(), path: z.string(), layer: Layer }).strict()),
    })
    .strict(),
  schema: z.record(z.string(), z.unknown()),
  new: PlanResult,
  "new feature": PlanResult,
  "plan show": PlanShow,
  "plan revise": PlanResult,
  "approve plan": Approved,
  "approve merge": MergeResult,
  run: z.union([RunResult, DryRun]),
  status: z.union([StatusOne, StatusList]),
  explain: Explain,
  watch: z
    .object({ run_id: z.string(), status: z.string(), reason: z.string().optional() })
    .strict(),
  hint: Hint,
  cancel: Cancelled,
  sync: Synced,
  handoff: HandedOff,
  adopt: Adopted,
  "merge status": MergeResult,
  ui: z.object({ url: z.string(), opened: z.boolean() }).strict(),
  stats: Stats,
} as const;
