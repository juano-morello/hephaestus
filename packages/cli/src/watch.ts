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
  "unit.stalled",
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

/** The parent a staged, stacked run still waits for to land (it merges only after its parent). */
export const waitingFor = (s: {
  run: { status: string };
  stack_on?: { run_id: string; status: string };
}): string | undefined =>
  s.run.status === "staged" && s.stack_on && ["built", "staged"].includes(s.stack_on.status)
    ? s.stack_on.run_id
    : undefined;

/** A staged child whose parent can never land as it is (failed, cancelled, paused...): the line to print. */
export const blockedByParent = (
  id: string,
  s: { run: { status: string }; stack_on?: { run_id: string; status: string } },
): string | undefined =>
  s.run.status === "staged" &&
  s.stack_on &&
  !["built", "staged", "finished"].includes(s.stack_on.status)
    ? `stacked on ${s.stack_on.run_id} (${s.stack_on.status}): rebuild ${id}`
    : undefined;

/** `signal`, when given, aborts the call (the MCP watch passes one; the CLI does not). */
export type WatchView = {
  status(
    id: string,
    signal?: AbortSignal,
  ): Promise<{
    run: { status: string };
    plan_approved: boolean;
    stack_on?: { run_id: string; status: string };
  }>;
  explain(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ events: WatchEvent[] }> | { events: WatchEvent[] };
};

export type Watched = { run_id: string; status: string; reason?: string };

/** Where a run stands for a watcher; every value but `running` is a stop (see classifyRun). */
export type WatchOutcome =
  | "running"
  | "awaiting_plan_approval"
  | "waiting_for_you"
  | "planner_escalated"
  | "waiting_for_parent"
  | "blocked_by_parent"
  | "staged"
  | "finished"
  | "failed";

export type Classified = {
  outcome: WatchOutcome;
  /** Lines both watchers print at this stop: a stacked child's parent line. */
  notes: string[];
  /** Why the watch stopped, when the status alone does not say. */
  reason?: string;
  /** The parent a staged child still waits for to land. */
  waiting_for?: string;
  /** Why a staged child's parent can never land as it is. */
  blocked?: string;
};

/**
 * The one status-to-outcome step `heph watch` (watchRun) and the MCP heph_watch (mcp/watch.ts)
 * share. Pure: a status answer and the run's events in, the outcome out. `built` (the instant
 * before staging) and a pause that is not for the user (a rate limit) are still `running`.
 * `awaiting_plan_approval` stops the MCP step; watchRun says it once and keeps watching.
 */
export function classifyRun(
  id: string,
  s: Awaited<ReturnType<WatchView["status"]>>,
  events: WatchEvent[],
): Classified {
  const status = s.run.status;
  if (status === "planned" && !s.plan_approved)
    return { outcome: "awaiting_plan_approval", notes: [] };
  if (status === "escalated")
    return { outcome: "planner_escalated", notes: [], reason: "planner escalated" };
  const last = events.findLast((e) => e.type === "run.paused");
  // A stalled unit pauses the run with this summary too.
  if (status === "paused" && last?.summary.includes("waiting for you"))
    return { outcome: "waiting_for_you", notes: [], reason: "waiting for you" };
  if (status === "staged") {
    const blocked = blockedByParent(id, s);
    if (blocked)
      return { outcome: "blocked_by_parent", notes: [blocked], reason: blocked, blocked };
    const parent = waitingFor(s);
    if (parent)
      return {
        outcome: "waiting_for_parent",
        notes: [`waiting for ${parent}`],
        reason: `waiting for ${parent}`,
        waiting_for: parent,
      };
    return { outcome: "staged", notes: [] };
  }
  if (status === "finished" || status === "failed") return { outcome: status, notes: [] };
  return { outcome: "running", notes: [] };
}

/** heph watch's closing lines for a stop, with the CLI command to run next. */
const stopLines = (id: string, status: string, c: Classified): string[] => {
  switch (c.outcome) {
    case "planner_escalated":
      return [`${id}: the planner escalated; heph explain ${id}`];
    case "waiting_for_you":
      return [`${id}: waiting for you; heph explain ${id}`];
    case "waiting_for_parent":
    case "blocked_by_parent":
      return [`${id}: staged`, ...c.notes];
    case "staged":
      return [`${id}: staged; review, then heph approve merge ${id}`];
    default:
      return [`${id}: ${status}`];
  }
};

/** The line for a run that has been quiet a while: the open attempt and its age, or the run. */
export const heartbeatLine = (id: string, events: WatchEvent[], now: number): string => {
  const open = events.findLast((e) => e.type === "unit.attempt.started");
  const closed =
    open &&
    events.some(
      (e) =>
        e.id > open.id &&
        e.unit_id === open.unit_id &&
        (e.type === "unit.attempt.finished" || e.type === "unit.attempt.interrupted"),
    );
  if (!open || closed) return `${id}: still running`;
  const min = open.ts ? Math.round((now - Date.parse(open.ts)) / 60_000) : 0;
  return watchLine({ ...open, summary: `still working, ${min} min into this attempt` });
};

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
      const c = classifyRun(id, s, events);
      if (c.outcome === "awaiting_plan_approval") {
        if (!told) say(`waiting for your approval: heph approve plan ${id}`);
        told = true;
      } else if (c.outcome !== "running") {
        for (const l of stopLines(id, status, c)) say(l);
        return { run_id: id, status, ...(c.reason ? { reason: c.reason } : {}) };
      }
    } catch (e) {
      if (++failures > (opts.retries ?? 30)) throw e;
    }
    // Attempts run for minutes without an event: say so, or the watcher looks dead.
    if (current === "running" && now() - lastOut >= beat) {
      try {
        const { events } = await view.explain(id);
        say(heartbeatLine(id, events, now()));
      } catch {
        // The next poll reports a real failure.
      }
    }
    await sleep(interval);
  }
}
