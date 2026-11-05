// A unit that fails the same way twice in a row is stalled: more attempts will not change a
// structural failure (a criterion outside its scope, say), so the engine asks the user instead.
// Pure functions over ledger events; no model judgment.

import { createHash } from "node:crypto";
import type { Return } from "@hephaestus/core";
import type { LedgerEvent } from "@hephaestus/ledger";

/** Identifies how an attempt failed: its failing gates, reasons and evidence, order aside. */
export function stallSignature(r: Pick<Return, "reasons">): string {
  const lines = r.reasons
    .map((x) => `${x.gate} | ${x.reason} | ${x.evidence.join(" / ")}`)
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
