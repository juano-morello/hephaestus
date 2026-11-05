// A cursor-based long-poll of a run's milestones, for the MCP heph_watch tool. Same polling as
// `watchRun` (src/watch.ts) and the same classification (classifyRun), but stateless: the caller
// carries the cursor.
import {
  classifyRun,
  heartbeatLine,
  isMilestone,
  type WatchOutcome,
  type WatchView,
  watchLine,
} from "../watch.ts";

export type Outcome = WatchOutcome;

export type WatchStepResult = {
  run_id: string;
  status: string;
  lines: string[];
  cursor: string | undefined;
  outcome: Outcome;
  /** A staged child's parent it still waits for, or why its parent blocks it. */
  waiting_for?: string | undefined;
  blocked?: string | undefined;
};

export async function watchStep(
  id: string,
  view: WatchView,
  o: {
    since?: string;
    waitMs: number;
    intervalMs?: number;
    retries?: number;
    heartbeatMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    onLine?: (line: string) => void;
  },
): Promise<WatchStepResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const interval = o.intervalMs ?? 2000;
  const beat = o.heartbeatMs ?? 0;
  const retries = o.retries ?? 30;
  const start = now();
  const deadline = start + o.waitMs;
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    o.onLine?.(l);
  };
  let failures = 0;
  for (;;) {
    let s: Awaited<ReturnType<WatchView["status"]>>;
    let events: Awaited<ReturnType<WatchView["explain"]>>["events"];
    try {
      s = await view.status(id);
      ({ events } = await view.explain(id));
      failures = 0;
    } catch (e) {
      // Retry a daemon restart, but not past the caller's wait: waitMs 0 with a dead daemon fails fast.
      if (++failures > retries || now() >= deadline + interval) throw e;
      await sleep(interval);
      continue;
    }
    const milestones = events.filter(isMilestone);
    const catchUp = o.since === undefined;
    const fresh = catchUp
      ? milestones.slice(-3)
      : milestones.filter((e) => e.id > (o.since as string));
    const cursor = [o.since ?? "", ...events.map((e) => e.id)].sort().at(-1) || undefined;
    const status = s.run.status;
    if (catchUp) say(`${id}: ${status}`);
    for (const e of fresh) say(watchLine(e));

    const c = classifyRun(id, s, events);
    const outcome = c.outcome;
    // Only a stop has notes (a stacked child's parent line), so they always end the step.
    for (const l of c.notes) say(l);

    const done = (): WatchStepResult => ({
      run_id: id,
      status,
      lines,
      cursor,
      outcome,
      waiting_for: c.waiting_for,
      blocked: c.blocked,
    });
    if (catchUp || fresh.length > 0 || outcome !== "running") return done();

    if (now() >= deadline) {
      // Attempts run for minutes without an event: say so, or the caller thinks the run is dead.
      if (status === "running" && now() - start >= beat) say(heartbeatLine(id, events, now()));
      return done();
    }
    await sleep(Math.min(interval, Math.max(0, deadline - now())));
  }
}
