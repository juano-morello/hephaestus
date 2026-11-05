import { type Plan, readyUnits, type Workspace } from "@hephaestus/core";

export type PauseReason = "rate_limit" | "handoff" | "user";

/** How one unit ended. `detail` is what the build reports, e.g. `T2: blocked: ...`. */
export type UnitResult =
  | { status: "accepted"; files: string[] }
  | { status: "paused"; reason: PauseReason; detail: string; retryAfter?: string }
  | { status: "cancelled"; reason: string };

export type ScheduleOutcome =
  | { kind: "done" }
  | { kind: "paused"; reason: PauseReason; detail: string; retryAfter?: string }
  | { kind: "cancelled"; reason: string };

/** Which pause the run reports when several units stop: the one needing the most attention. */
export const PAUSE_RANK: Record<PauseReason, number> = { handoff: 3, user: 2, rate_limit: 1 };

const later = (a: string | undefined, b: string | undefined) => {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) >= Date.parse(a) ? b : a;
};

type Settled = { id: string; result?: UnitResult; error?: unknown };

/**
 * Runs units from the ready set over a pool of `parallel` slots (SPEC section 4.1). The first
 * unit that doesn't end accepted, or `stopped()`, starts the drain: nothing new starts, units in
 * flight finish and are kept if accepted. Returns one outcome for the whole build: cancelled wins,
 * then a pause by precedence handoff, user, rate_limit (with the latest retry-after). `done` with
 * units left over means `stopped()` drained it; the caller reports that stop itself.
 */
export async function schedule(o: {
  plan: Plan;
  workspace: Workspace;
  parallel: number;
  accepted: Map<string, string[]>;
  scopeOf(id: string): string[];
  start(id: string): Promise<UnitResult>;
  stopped(): boolean;
}): Promise<ScheduleOutcome> {
  const inFlight = new Map<string, Promise<Settled>>();
  let draining = false;
  let cancelled: string | undefined;
  let paused: { reason: PauseReason; detail: string } | undefined;
  let retryAfter: string | undefined;
  let failure: { error: unknown } | undefined;

  const launch = async (id: string): Promise<Settled> => {
    try {
      return { id, result: await o.start(id) };
    } catch (error) {
      return { id, error };
    }
  };

  for (;;) {
    if (!draining && o.stopped()) draining = true;
    if (!draining) {
      const ready = readyUnits(
        o.plan,
        o.workspace,
        {
          accepted: new Set(o.accepted.keys()),
          inFlight: new Set(inFlight.keys()),
          scopeOf: o.scopeOf,
        },
        Math.max(0, o.parallel - inFlight.size),
      );
      for (const id of ready) inFlight.set(id, launch(id));
    }
    if (inFlight.size === 0) break;

    const { id, result, error } = await Promise.race(inFlight.values());
    inFlight.delete(id);
    if (!result) {
      failure ??= { error };
      draining = true;
    } else if (result.status === "accepted") {
      o.accepted.set(id, result.files);
    } else if (result.status === "cancelled") {
      cancelled ??= result.reason;
      draining = true;
    } else {
      draining = true;
      if (result.reason === "rate_limit") retryAfter = later(retryAfter, result.retryAfter);
      if (!paused || PAUSE_RANK[result.reason] > PAUSE_RANK[paused.reason])
        paused = { reason: result.reason, detail: result.detail };
    }
  }

  if (failure) throw failure.error;
  if (cancelled !== undefined) return { kind: "cancelled", reason: cancelled };
  if (paused) {
    return paused.reason === "rate_limit" && retryAfter
      ? { kind: "paused", ...paused, retryAfter }
      : { kind: "paused", ...paused };
  }
  const left = o.plan.tasks.filter((t) => !o.accepted.has(t.id)).map((t) => t.id);
  if (left.length > 0 && !draining) throw new Error(`no unit can start: ${left.join(", ")}`);
  return { kind: "done" };
}
