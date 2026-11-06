// A unit that fails the same way twice in a row is stalled: more attempts will not change a
// structural failure (a criterion outside its scope, say), so the engine asks the user instead.
// Pure functions over ledger events; no model judgment.

import { createHash } from "node:crypto";
import type { Return } from "@hephaestus/core";
import type { LedgerEvent } from "@hephaestus/ledger";

/**
 * Evidence with the parts that change between identical failures blanked: durations, "(cached)"
 * markers, timestamps, temp paths, hex addresses. Counts and names stay (4 bots is not 5 bots).
 */
export function normalizeEvidence(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\(cached\)/g, "<t>")
    .replace(/\b\d+(\.\d+)?\s?(ns|µs|μs|us|ms|s)\b/g, "<t>")
    .replace(/\b\d+m\d+(\.\d+)?s\b/g, "<t>")
    .replace(/(\/private)?(\/var\/folders|\/tmp)\/[^\s:'"]+/g, "<tmp>")
    .replace(/0x[0-9a-f]{6,}/gi, "<addr>");
}

/** Identifies how an attempt failed: its failing gates, reasons and evidence, order aside. */
export function stallSignature(r: Pick<Return, "reasons">): string {
  const lines = r.reasons
    .map((x) => normalizeEvidence(`${x.gate} | ${x.reason} | ${x.evidence.join(" / ")}`))
    .sort()
    .join("\n");
  return createHash("sha256").update(lines).digest("hex").slice(0, 12);
}

/**
 * Whether the unit's last two red attempts failed the same way. `events` are the run's events
 * since its latest plan. The comparison spans escalations and restarts after a human.input for
 * the unit (or the whole run): a hint changes what the next attempt can do.
 */
export function isStalled(
  events: LedgerEvent[],
  unitId: string,
): { attempts: [number, number]; signature: string } | undefined {
  const reset = events.findLastIndex(
    (e) => e.type === "human.input" && (!e.unit_id || e.unit_id === unitId),
  );
  const returns = events
    .slice(reset + 1)
    .filter((e) => e.type === "unit.returned" && e.unit_id === unitId);
  const [a, b] = returns.slice(-2);
  if (!a || !b || a.type !== "unit.returned" || b.type !== "unit.returned") return undefined;
  const signature = stallSignature(b.data);
  if (stallSignature(a.data) !== signature) return undefined;
  return { attempts: [a.attempt ?? 0, b.attempt ?? 0], signature };
}

/** Why a stalled unit stopped: the gate, the attempts, and the evidence that repeated. */
export function stallReason(
  gate: string | undefined,
  [a, b]: [number, number],
  evidence?: string,
): string {
  return `stalled: ${gate} failed the same way on a${a} and a${b}${evidence ? ` (repeated: ${evidence})` : ""}`;
}

/** "2 files changed, +3 -2: a.go (+2 -1), b.go (+1 -1)" from a unified diff. */
export function diffStat(text: string): string {
  const files: { path: string; add: number; del: number }[] = [];
  for (const line of text.split("\n")) {
    const head = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (head) files.push({ path: head[2] ?? "", add: 0, del: 0 });
    const f = files.at(-1);
    if (!f || line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) f.add++;
    else if (line.startsWith("-")) f.del++;
  }
  if (!files.length) return "no changes";
  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  const list = files.map((f) => `${f.path} (+${f.add} -${f.del})`).join(", ");
  return `${files.length} file${files.length === 1 ? "" : "s"} changed, +${add} -${del}: ${list}`;
}

const SIGNAL =
  /fail|error|panic|expected|want|out of scope|outside|locked|cannot|no such|timed out/i;

/** The few lines of failing evidence that say what repeated; passing output is dropped. */
export function stuckEvidence(evidence: string[], max = 400): string {
  const lines = evidence
    .flatMap((e) => e.split("\n"))
    .map((l) => l.trim())
    .filter(Boolean);
  const picked = lines.filter((l) => SIGNAL.test(l) && !/^ok\b/.test(l));
  const out = (picked.length ? picked : lines).slice(0, 4).join(" | ");
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

export type HintCategory =
  | "scope conflict"
  | "locked-test conflict"
  | "path mismatch"
  | "flaky infra"
  | "other";

/** A rough, rule-based read of why a gate keeps failing, and the hint that usually unblocks it. */
export function categorize(f: { gate: string; reason: string; evidence: string[] }): {
  category: HintCategory;
  suggestion: string;
} {
  const text = `${f.reason}\n${f.evidence.join("\n")}`;
  if (f.gate === "locked_paths" || /locked/i.test(text))
    return {
      category: "locked-test conflict",
      suggestion:
        "the unit keeps editing a locked test; hint which side is right (fix the code to the test, or unlock/replan the test)",
    };
  if (f.gate === "diff_scope" || /out of scope|outside (the )?(task )?(scope|project)/i.test(text))
    return {
      category: "scope conflict",
      suggestion:
        "the unit needs files outside its scope; allow them with heph hint --scope <globs>, or hint that it must avoid them",
    };
  if (
    /no such file|cannot find|not found|ENOENT|does not exist|no matching files|module not found/i.test(
      text,
    )
  )
    return {
      category: "path mismatch",
      suggestion:
        "a path in the spec or tests does not exist; hint the correct path or where it lives",
    };
  if (
    /timed out|timeout|connection refused|ECONN|deadline exceeded|too many open|address already in use|flak|rate limit/i.test(
      text,
    )
  )
    return {
      category: "flaky infra",
      suggestion:
        "looks environmental or flaky; hint to retry or run that check in isolation, or raise the gate timeout",
    };
  return {
    category: "other",
    suggestion:
      "read the evidence and hint what the unit is missing; more attempts alone will not change it",
  };
}

export type Diagnosis = {
  unit_id: string;
  gate: string;
  reason: string;
  /** How many consecutive returns failed this same gate. */
  repeated: number;
  evidence: string[];
  attempts: { attempt: number; outcome?: string; changed?: string }[];
  category: HintCategory;
  suggestion: string;
};

/**
 * Why a unit is failing, from the ledger alone: the gate that failed on its latest return (and
 * how many returns in a row failed it), its evidence, what each attempt changed, and a hint
 * category. `blob` reads a stored diff; undefined when it is gone.
 */
export function diagnose(
  events: LedgerEvent[],
  unitId: string,
  blob: (id: string) => string | undefined,
): Diagnosis | undefined {
  const mine = events.filter((e) => e.unit_id === unitId);
  const returns = mine.filter((e) => e.type === "unit.returned");
  const last = returns.at(-1);
  if (last?.type !== "unit.returned") return undefined;
  const top = last.data.reasons[0];
  if (!top) return undefined;
  let repeated = 0;
  for (const r of returns.toReversed()) {
    if (r.type === "unit.returned" && r.data.reasons.some((x) => x.gate === top.gate)) repeated++;
    else break;
  }
  const attempts = mine
    .filter((e) => e.type === "unit.attempt.finished")
    .map((e) => {
      const id = e.blobs?.diff;
      let text: string | undefined;
      try {
        text = id ? blob(id) : undefined;
      } catch {}
      const data = e.data as { outcome?: string };
      return {
        attempt: e.attempt ?? 0,
        ...(data.outcome ? { outcome: data.outcome } : {}),
        ...(text !== undefined ? { changed: diffStat(text) } : {}),
      };
    });
  return {
    unit_id: unitId,
    gate: top.gate,
    reason: top.reason,
    repeated,
    evidence: top.evidence,
    attempts,
    ...categorize(top),
  };
}
