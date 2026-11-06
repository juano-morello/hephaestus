// A unit that fails the same way twice in a row is stalled: more attempts will not change a
// structural failure (a criterion outside its scope, say), so the engine asks the user instead.
// Pure functions over ledger events; no model judgment.

import { createHash } from "node:crypto";
import type { Return } from "@hephaestus/core";
import type { LedgerEvent } from "@hephaestus/ledger";

/**
 * Evidence lines that start with "detail:" explain a failure for humans (a timing, a count, the
 * provider's message) and vary run to run; they are left out of the signature, so two hangs
 * for the same reason count as the same failure.
 */
const DETAIL = "detail: ";
const isDetail = (line: string) => line.startsWith(DETAIL);

/** "reason (detail)" when the gate recorded a detail line, else undefined. */
export function failureDetail(r: Return["reasons"][number]): string | undefined {
  const detail = r.evidence.find(isDetail);
  return detail ? `${r.reason} (${detail.slice(DETAIL.length)})` : undefined;
}

/** Identifies how an attempt failed: its failing gates, reasons and evidence, order aside. */
export function stallSignature(r: Pick<Return, "reasons">): string {
  const lines = r.reasons
    .map((x) => `${x.gate} | ${x.reason} | ${x.evidence.filter((e) => !isDetail(e)).join(" / ")}`)
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
