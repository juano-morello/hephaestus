// heph watch: a run's milestones, one line each, for an agent that follows a build in the
// background (Claude Code's Monitor sends every stdout line to the agent). Not every event:
// gate passes and context packs are noise there.

export type WatchEvent = {
  id: string;
  type: string;
  summary: string;
  unit_id?: string;
  attempt?: number;
};

const MILESTONES = new Set([
  "run.plan_ready",
  "run.plan_escalated",
  "run.paused",
  "run.resumed",
  "run.handed_off",
  "run.adopted",
  "run.finished",
  "run.failed",
  "unit.attempt.started",
  "unit.attempt.finished",
  "unit.attempt.interrupted",
  "unit.returned",
  "unit.accepted",
  "unit.escalated",
  "unit.needs_input",
  "merge.staged",
  "merge.committed",
  "merge.aborted",
  "human.input",
]);

/** Whether an event is worth a line: milestones, and the effects that produced a pull request. */
export const isMilestone = (e: WatchEvent) =>
  MILESTONES.has(e.type) || (e.type === "effect.done" && /https?:\/\//.test(e.summary));

export const watchLine = (e: WatchEvent) =>
  `${e.unit_id ? `${e.unit_id}${e.attempt ? `/a${e.attempt}` : ""} ` : ""}${e.summary}`;

export type WatchView = {
  status(id: string): Promise<{ run: { status: string }; plan_approved: boolean }>;
  explain(id: string): Promise<{ events: WatchEvent[] }> | { events: WatchEvent[] };
};

export type Watched = { run_id: string; status: string; reason?: string };

/**
 * Prints new milestones until the run ends or needs the user: staged, finished, failed, the
 * planner's escalation, or a pause that waits for the user. Other pauses (a rate limit) are
 * waited out. Transient errors (the daemon restarting) are retried for about a minute.
 */
export async function watchRun(
  id: string,
  view: WatchView,
  out: (line: string) => void,
  opts: { intervalMs?: number; sleep?: (ms: number) => Promise<void>; retries?: number } = {},
): Promise<Watched> {
  const interval = opts.intervalMs ?? 2000;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  let seen: string | undefined;
  let told = false;
  let failures = 0;
  for (;;) {
    try {
      const s = await view.status(id);
      const { events } = await view.explain(id);
      failures = 0;
      // The first look prints where the run stands now, not its history.
      const fresh =
        seen === undefined
          ? []
          : events.slice(events.findIndex((e) => e.id === seen) + 1).filter(isMilestone);
      if (seen === undefined) out(`${id}: ${s.run.status}`);
      for (const e of fresh) out(watchLine(e));
      seen = events.at(-1)?.id ?? seen ?? "";
      const status = s.run.status;
      const last = events.findLast((e) => e.type === "run.paused");
      const waitingForUser = status === "paused" && last?.summary.includes("waiting for you");
      if (status === "planned" && !s.plan_approved) {
        if (!told) out(`waiting for your approval: heph approve plan ${id}`);
        told = true;
      } else if (status === "escalated") {
        out(`${id}: the planner escalated; heph explain ${id}`);
        return { run_id: id, status, reason: "planner escalated" };
      } else if (waitingForUser) {
        out(`${id}: waiting for you; heph explain ${id}`);
        return { run_id: id, status, reason: "waiting for you" };
      } else if (["staged", "finished", "failed", "built"].includes(status)) {
        // `built` is the instant before staging; wait one more look for the staged line.
        if (status !== "built") {
          out(
            `${id}: ${status}${status === "staged" ? `; review, then heph approve merge ${id}` : ""}`,
          );
          return { run_id: id, status };
        }
      }
    } catch (e) {
      if (++failures > (opts.retries ?? 30)) throw e;
    }
    await sleep(interval);
  }
}
