// heph watch: a run's milestones, one line each, for an agent that follows a build in the
// background (Claude Code's Monitor sends every stdout line to the agent). Not every event:
// gate passes and context packs are noise there.

export type WatchEvent = {
  id: string;
  ts?: string;
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
  opts: {
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    retries?: number;
    /** Silence longer than this gets a "still working" line (default 60 s). */
    heartbeatMs?: number;
    /** How many past milestones the first look shows (default 3). */
    catchUp?: number;
    now?: () => number;
  } = {},
): Promise<Watched> {
  const now = opts.now ?? Date.now;
  const beat = opts.heartbeatMs ?? 60_000;
  let lastOut = now();
  const say = (l: string) => {
    lastOut = now();
    out(l);
  };
  const interval = opts.intervalMs ?? 2000;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  let seen: string | undefined;
  let told = false;
  let failures = 0;
  let current = "";
  for (;;) {
    try {
      const s = await view.status(id);
      const { events } = await view.explain(id);
      failures = 0;
      // The first look prints where the run stands and its last few milestones; after that, what
      // is new (event ids are ULIDs, so they sort by time even when a sync reorders the list).
      const milestones = events.filter(isMilestone);
      const fresh =
        seen === undefined
          ? milestones.slice(-(opts.catchUp ?? 3))
          : milestones.filter((e) => e.id > (seen as string));
      if (seen === undefined) say(`${id}: ${s.run.status}`);
      for (const e of fresh) say(watchLine(e));
      seen = [seen ?? "", ...events.map((e) => e.id)].sort().at(-1) as string;
      const status = s.run.status;
      current = status;
      const last = events.findLast((e) => e.type === "run.paused");
      const waitingForUser = status === "paused" && last?.summary.includes("waiting for you");
      if (status === "planned" && !s.plan_approved) {
        if (!told) say(`waiting for your approval: heph approve plan ${id}`);
        told = true;
      } else if (status === "escalated") {
        say(`${id}: the planner escalated; heph explain ${id}`);
        return { run_id: id, status, reason: "planner escalated" };
      } else if (waitingForUser) {
        say(`${id}: waiting for you; heph explain ${id}`);
        return { run_id: id, status, reason: "waiting for you" };
      } else if (["staged", "finished", "failed", "built"].includes(status)) {
        // `built` is the instant before staging; wait one more look for the staged line.
        if (status !== "built") {
          say(
            `${id}: ${status}${status === "staged" ? `; review, then heph approve merge ${id}` : ""}`,
          );
          return { run_id: id, status };
        }
      }
    } catch (e) {
      if (++failures > (opts.retries ?? 30)) throw e;
    }
    // Attempts run for minutes without an event: say so, or the watcher looks dead.
    if (current === "running" && now() - lastOut >= beat) {
      try {
        const { events } = await view.explain(id);
        const open = events.findLast((e) => e.type === "unit.attempt.started");
        const closed =
          open &&
          events.some(
            (e) =>
              e.id > open.id &&
              e.unit_id === open.unit_id &&
              (e.type === "unit.attempt.finished" || e.type === "unit.attempt.interrupted"),
          );
        const since = open?.ts && !closed ? Math.round((now() - Date.parse(open.ts)) / 60_000) : 0;
        say(
          open && !closed
            ? `${watchLine({ ...open, summary: `still working, ${since} min into this attempt` })}`
            : `${id}: still running`,
        );
      } catch {
        // The next poll reports a real failure.
      }
    }
    await sleep(interval);
  }
}
