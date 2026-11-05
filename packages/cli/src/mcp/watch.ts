// A cursor-based long-poll of a run's milestones, for the MCP heph_watch tool. Same polling and
// classification as `watchRun` (src/watch.ts), but stateless: the caller carries the cursor.
import { isMilestone, type WatchView, watchLine } from "../watch.ts";

export type Outcome =
  | "running"
  | "awaiting_plan_approval"
  | "waiting_for_you"
  | "planner_escalated"
  | "staged"
  | "finished"
  | "failed";

export type WatchStepResult = {
  run_id: string;
  status: string;
  lines: string[];
  cursor: string | undefined;
  outcome: Outcome;
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
  const beat = o.heartbeatMs ?? 60_000;
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
      if (++failures > retries) throw e;
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

    const lastPause = events.findLast((e) => e.type === "run.paused");
    let outcome: Outcome = "running";
    if (status === "planned" && !s.plan_approved) outcome = "awaiting_plan_approval";
    else if (status === "escalated") outcome = "planner_escalated";
    else if (status === "paused" && lastPause?.summary.includes("waiting for you"))
      outcome = "waiting_for_you";
    else if (status === "staged" || status === "finished" || status === "failed") outcome = status;

    const done = (): WatchStepResult => ({ run_id: id, status, lines, cursor, outcome });
    if (catchUp || fresh.length > 0 || outcome !== "running") return done();

    if (now() >= deadline) {
      // Attempts run for minutes without an event: say so, or the caller thinks the run is dead.
      if (status === "running" && now() - start >= beat) {
        const open = events.findLast((e) => e.type === "unit.attempt.started");
        const closed =
          open &&
          events.some(
            (e) =>
              e.id > open.id &&
              e.unit_id === open.unit_id &&
              (e.type === "unit.attempt.finished" || e.type === "unit.attempt.interrupted"),
          );
        if (open && !closed) {
          const min = open.ts ? Math.round((now() - Date.parse(open.ts)) / 60_000) : 0;
          say(watchLine({ ...open, summary: `still working, ${min} min into this attempt` }));
        } else say(`${id}: still running`);
      }
      return done();
    }
    await sleep(Math.min(interval, Math.max(0, deadline - now())));
  }
}
