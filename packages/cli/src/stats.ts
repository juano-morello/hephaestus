// heph stats: the kill-criteria report (SPEC sections 14 and 18). Pure functions over the ledger's
// runs and events; the runtime reads the ledger and calls them.
import type { RunRow } from "@hephaestus/ledger";
import type { Stats } from "./output.ts";

export type RunClass = "clean" | "assisted" | "did_not_merge" | "open";
type Ev = { type: string; data?: unknown };

export const FOOTER =
  "Cannot see: manual edits made outside heph or on GitHub after a PR was opened, nor work done in direct sessions that never went through heph.";

/** The SPEC's line: fewer than half of the runs reaching merge cleanly is a failing harness. */
const THRESHOLD = 0.5;
const MERGE_READY = new Set(["staged", "finished"]);
const DID_NOT_MERGE = new Set(["failed", "escalated"]);
const HINT_KINDS = new Set(["hint", "budget_override", "scope"]);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const kindOf = (e: Ev) => (e.data as { kind?: string } | undefined)?.kind;

export function classifyRun(
  row: { status: string },
  events: Ev[],
): {
  class: RunClass;
  reasons: string[];
  hints: number;
  replans: number;
  escalations: number;
  stalls: number;
} {
  const count = (type: string) => events.filter((e) => e.type === type).length;
  const inputs = events.filter((e) => e.type === "human.input");
  const hints = inputs.filter((e) => HINT_KINDS.has(kindOf(e) ?? "")).length;
  const planEdits = inputs.filter((e) => kindOf(e) === "plan_edit").length;
  const replans = Math.max(count("run.plan_ready") - 1, planEdits);
  const escalations = count("unit.escalated");
  const stalls = count("unit.stalled");
  const counts = { hints, replans, escalations, stalls };

  if (MERGE_READY.has(row.status)) {
    const reasons = [
      ...(replans ? ["replanned"] : []),
      ...(hints ? [plural(hints, "hint")] : []),
      ...(escalations ? [plural(escalations, "escalation")] : []),
      ...(stalls ? [plural(stalls, "stall")] : []),
    ];
    return { class: reasons.length ? "assisted" : "clean", reasons, ...counts };
  }
  if (DID_NOT_MERGE.has(row.status)) {
    const failure = events.findLast((e) => e.type === "run.failed");
    const reason =
      row.status === "escalated"
        ? "planner escalated"
        : (failure?.data as { reason?: string } | undefined)?.reason === "cancelled by user"
          ? "cancelled"
          : "failed";
    return { class: "did_not_merge", reasons: [reason], ...counts };
  }
  return { class: "open", reasons: [], ...counts };
}

export function buildStats(o: {
  runs: RunRow[];
  eventsOf: (runId: string) => Ev[];
  since: Date;
  list?: boolean;
}): Stats {
  const counts = { clean: 0, assisted: 0, did_not_merge: 0, open: 0 };
  const totals = { hints: 0, replans: 0, escalations: 0, stalls: 0 };
  const runs: NonNullable<Stats["runs"]> = [];
  for (const row of o.runs) {
    if (row.eval || Date.parse(row.created_at) < o.since.getTime()) continue;
    const c = classifyRun(row, o.eventsOf(row.run_id));
    counts[c.class]++;
    if (c.class === "assisted") {
      totals.hints += c.hints;
      totals.replans += c.replans;
      totals.escalations += c.escalations;
      totals.stalls += c.stalls;
    }
    runs.push({ run_id: row.run_id, status: row.status, class: c.class, reasons: c.reasons });
  }
  const closed = counts.clean + counts.assisted + counts.did_not_merge;
  const rate = closed ? counts.clean / closed : null;
  return {
    schema: 1,
    since: o.since.toISOString(),
    counts,
    clean_rate: rate,
    below_threshold: rate === null ? null : rate < THRESHOLD,
    assisted_totals: totals,
    ...(o.list ? { runs } : {}),
    footer: FOOTER,
  };
}

/** `<N>d` is N days before now; otherwise an ISO date. */
export function parseSince(text: string, now: Date = new Date()): Date {
  const days = /^(\d+)d$/.exec(text);
  if (days) return new Date(now.getTime() - Number(days[1]) * 86_400_000);
  const at = /^\d{4}-\d{2}-\d{2}/.test(text) ? Date.parse(text) : Number.NaN;
  if (Number.isNaN(at)) throw new Error("--since takes <N>d or a date");
  return new Date(at);
}

const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;

/** The human form of `heph stats`. */
export function statsText(s: Stats): string {
  const t = s.assisted_totals;
  return `${[
    `runs since ${s.since.slice(0, 10)}: ${s.counts.clean} clean, ${s.counts.assisted} assisted, ${s.counts.did_not_merge} did not merge, ${s.counts.open} open`,
    s.clean_rate === null
      ? "clean rate: n/a (no closed runs yet)"
      : `clean rate: ${pct(s.clean_rate)}, ${s.below_threshold ? "below" : "above"} the SPEC's 50% line`,
    `assisted runs needed: ${plural(t.hints, "hint")}, ${plural(t.replans, "replan")}, ${plural(t.escalations, "escalation")}, ${plural(t.stalls, "stall")}`,
    ...(s.runs ?? []).map((r) => `${r.run_id}  ${r.class}  ${r.reasons.join(", ")}`),
    s.footer,
    "",
  ].join("\n")}`;
}
