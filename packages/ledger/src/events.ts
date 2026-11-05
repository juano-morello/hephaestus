import { Brief, Complexity, GateResult, Plan, Return } from "@hephaestus/core";
import { z } from "zod";

const Id = z.string().min(1);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "must be a sha256 hex id");
const CommitSha = z.string().regex(/^[0-9a-f]{7,40}$/, "must be a commit sha");
const Reason = z.object({ reason: z.string().min(1) }).strict();
const Empty = z.object({}).strict();

export const Actor = z.enum(["engine", "worker", "human", "gate"]);
export type Actor = z.infer<typeof Actor>;

/** SPEC section 6. `data` is checked separately, per type. */
export const Envelope = z
  .object({
    id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a ULID"),
    ts: z.iso.datetime(),
    type: z.string().min(1),
    schema: z.literal(1),
    node_id: Id,
    run_id: Id,
    changeset_id: Id,
    repo: Id.optional(),
    project: Id.optional(),
    graph_node: Id.optional(),
    unit_id: Id.optional(),
    attempt: z.number().int().positive().optional(),
    runner_id: Id.optional(),
    actor: Actor,
    config_hash: Id,
    prompt_hash: Id.optional(),
    data: z.unknown(),
    blobs: z
      .object({ transcript: Sha256.optional(), diff: Sha256.optional(), log: Sha256.optional() })
      .strict()
      .optional(),
  })
  .strict();
export type Envelope = z.infer<typeof Envelope>;

type EnvelopeField = "unit_id" | "attempt" | "graph_node";

const AttemptInfo = {
  role: Id,
  tier: Complexity,
  model: Id,
  effort: Id.optional(),
  provider: Id,
};

export const Usage = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cache_read: z.number().int().nonnegative(),
    cache_write: z.number().int().nonnegative(),
  })
  .strict();
export type Usage = z.infer<typeof Usage>;

const PauseReason = z.enum(["rate_limit", "handoff", "user"]);
const ResumeReason = z.enum(["rate_limit", "handoff", "user", "crash"]);

/** Every side effect outside the ledger goes intent, effect, confirm (SPEC section 13). */
export const EffectKind = z.enum([
  "run_branch_reset",
  "run_branch_advance",
  "rebase",
  "push",
  "staging_ref",
  "pr_open",
  "pr_edit",
  "pr_merge",
  "target_advance",
]);
export type EffectKind = z.infer<typeof EffectKind>;

const Refs = z.object({ refs: z.record(z.string(), CommitSha) }).strict();

const def = <S extends z.ZodType>(data: S, requires: EnvelopeField[] = []) => ({ data, requires });
const UNIT = ["unit_id"] as EnvelopeField[];
const ATTEMPT = ["unit_id", "attempt"] as EnvelopeField[];

/** Every v0 event type (SPEC section 6) with its data schema and required envelope fields. */
export const EVENT_TYPES = {
  "run.created": def(
    z
      .object({
        owner_node: Id,
        brief_hash: Id,
        eval: z.boolean(),
        /** The Brief itself and the workspace root, so later commands can rebuild the run. */
        brief: Brief.optional(),
        workspace_root: z.string().min(1).optional(),
        /** How other nodes find their own checkout of the workspace (SPEC section 7). */
        workspace_name: z.string().min(1).optional(),
      })
      .strict(),
  ),
  "run.plan_ready": def(z.object({ plan: Plan }).strict()),
  "run.plan_escalated": def(z.object({ reasons: z.array(z.string().min(1)).min(1) }).strict()),
  "run.paused": def(
    z.object({ reason: PauseReason, retry_after: z.iso.datetime().optional() }).strict(),
  ),
  "run.resumed": def(z.object({ reason: ResumeReason }).strict()),
  "run.handed_off": def(z.object({ to: Id }).strict()),
  "run.adopted": def(z.object({ from: Id, reason: z.string().min(1) }).strict()),
  "run.finished": def(Empty),
  "run.failed": def(Reason),
  "node.started": def(Empty, ["graph_node"]),
  "node.finished": def(z.object({ outcome: z.string().min(1) }).strict(), ["graph_node"]),
  "unit.attempt.started": def(z.object(AttemptInfo).strict(), ATTEMPT),
  "unit.attempt.finished": def(
    z
      .object({
        ...AttemptInfo,
        usage: Usage,
        duration_ms: z.number().int().nonnegative(),
        outcome: z.enum(["green", "red", "blocked", "error"]),
      })
      .strict(),
    ATTEMPT,
  ),
  "unit.attempt.interrupted": def(
    z.object({ reason: z.enum(["rate_limit", "crash", "handoff", "user"]) }).strict(),
    ATTEMPT,
  ),
  "gate.result": def(GateResult),
  "unit.returned": def(Return, ATTEMPT),
  "unit.accepted": def(Empty, UNIT),
  "unit.escalated": def(Reason, UNIT),
  /** Two red attempts in a row failed the same way; the run waits for the user. */
  "unit.stalled": def(
    z
      .object({
        signature: z.string().min(1),
        attempts: z.tuple([z.number().int().positive(), z.number().int().positive()]),
        failing: z.array(z.object({ gate: z.string(), reason: z.string() }).strict()).min(1),
      })
      .strict(),
    UNIT,
  ),
  "unit.needs_input": def(Reason, UNIT),
  "merge.staged": def(
    z
      .object({
        refs: z.record(z.string(), CommitSha),
        /** Landing via pull requests: repo -> PR url. Absent for local fast-forward landings. */
        prs: z.record(z.string(), z.url()).optional(),
      })
      .strict(),
  ),
  "merge.committed": def(Refs),
  "merge.aborted": def(Reason),
  "human.input": def(
    z
      .object({
        kind: z.enum(["hint", "plan_edit", "budget_override", "approve", "scope"]),
        text: z.string().optional(),
        budget_tokens: z.number().int().positive().optional(),
        /** scope only: project-relative paths or globs the unit may also change. */
        scope: z.array(z.string().min(1)).min(1).optional(),
        /** approve only: what is approved; a plan approval names the run.plan_ready event id. */
        target: z.enum(["plan", "merge"]).optional(),
        plan: Id.optional(),
      })
      .strict()
      .superRefine((d, ctx) => {
        if (d.kind === "scope" && !d.scope)
          ctx.addIssue({ code: "custom", message: "a scope input names what it adds" });
        if (d.kind === "approve" && !d.target)
          ctx.addIssue({ code: "custom", message: "an approval needs a target" });
        if (d.kind === "approve" && d.target === "plan" && !d.plan) {
          ctx.addIssue({ code: "custom", message: "a plan approval names the plan it approves" });
        }
        if (d.kind !== "approve" && (d.target || d.plan)) {
          ctx.addIssue({ code: "custom", message: "target and plan are only for approvals" });
        }
      }),
  ),
  /** Written before the effect; `key` names it, so a resume can find one that never finished. */
  "effect.intended": def(
    z
      .object({
        effect: EffectKind,
        key: Id,
        /** What the effect changes: a ref, a branch or a pull request. */
        target: Id,
        before: CommitSha.optional(),
        after: CommitSha.optional(),
      })
      .strict(),
  ),
  /**
   * applied: done now. confirmed: a resume found it had already happened. abandoned: a resume
   * found it had not, and the step that wanted it runs again.
   */
  "effect.done": def(
    z
      .object({
        effect: EffectKind,
        key: Id,
        state: z.enum(["applied", "confirmed", "abandoned"]),
        sha: CommitSha.optional(),
        url: z.url().optional(),
      })
      .strict(),
  ),
  "context.pack_built": def(
    z
      .object({
        size_tokens: z.number().int().nonnegative(),
        truncated: z.array(z.string()),
        expansions: z.number().int().nonnegative(),
      })
      .strict(),
    ATTEMPT,
  ),
} as const;

export type EventType = keyof typeof EVENT_TYPES;
type DataOf<K extends EventType> = z.output<(typeof EVENT_TYPES)[K]["data"]>;

/** What callers append; the ledger stamps id, ts, schema and node_id. */
export type EventDraft<K extends EventType = EventType> = {
  [T in K]: Omit<Envelope, "id" | "ts" | "schema" | "node_id" | "type" | "data"> & {
    type: T;
    data: z.input<(typeof EVENT_TYPES)[T]["data"]>;
  };
}[K];

export type LedgerEvent<K extends EventType = EventType> = {
  [T in K]: Omit<Envelope, "type" | "data"> & { type: T; data: DataOf<T> };
}[K];

const isKnown = (type: string): type is EventType => Object.hasOwn(EVENT_TYPES, type);

const formatIssues = (error: z.ZodError, prefix = "") =>
  error.issues.map((i) => `${prefix}${i.path.join(".") || "(root)"}: ${i.message}`);

export type Validation = { ok: true; event: LedgerEvent } | { ok: false; issues: string[] };

/** Full check for an event about to be written: known type, data, required fields, consistency. */
export function validateEvent(input: unknown): Validation {
  const env = Envelope.safeParse(input);
  if (!env.success) return { ok: false, issues: formatIssues(env.error) };
  const e = env.data;
  if (!isKnown(e.type)) return { ok: false, issues: [`type: unknown event type "${e.type}"`] };

  const spec = EVENT_TYPES[e.type];
  const issues = spec.requires
    .filter((f) => e[f] === undefined)
    .map((f) => `${f}: required for ${e.type}`);

  const data = spec.data.safeParse(e.data);
  if (!data.success) issues.push(...formatIssues(data.error, "data."));
  else if (e.type === "unit.returned") {
    const r = data.data as Return;
    if (r.unit_id !== e.unit_id) {
      issues.push(`data.unit_id: ${r.unit_id} does not match envelope unit_id ${e.unit_id}`);
    }
    if (r.attempt !== e.attempt) {
      issues.push(`data.attempt: ${r.attempt} does not match envelope attempt ${e.attempt}`);
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, event: { ...e, data: data.data } as LedgerEvent };
}

export type StoredEvent = { known: true; event: LedgerEvent } | { known: false; event: Envelope };

/**
 * Tolerant read: the envelope must be valid, but an unknown type (written by a newer node)
 * is returned with its raw data instead of failing the whole read.
 */
export function parseStoredEvent(input: unknown): StoredEvent {
  const env = Envelope.safeParse(input);
  if (!env.success) throw new Error(`invalid stored event: ${formatIssues(env.error).join("; ")}`);
  if (!isKnown(env.data.type)) return { known: false, event: env.data };
  const data = EVENT_TYPES[env.data.type].data.parse(env.data.data);
  return { known: true, event: { ...env.data, data } as LedgerEvent };
}
