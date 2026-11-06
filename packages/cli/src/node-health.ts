// Which peer nodes the daemon can reach: backs off a node that keeps failing, and says so once
// (not on every sync) in the log.

export type NodeHealth = {
  ok: boolean;
  /** Consecutive failed syncs. */
  failures: number;
  /** When the current outage began (ISO). */
  since?: string;
  error?: string;
  last_ok_at?: string;
  /** When the daemon will try again (ISO), while the node is down. */
  next_try_at?: string;
};

const DEFAULT_MAX_BACKOFF_S = 15 * 60;

/** First line of an error, bounded: ssh errors repeat the whole command line. */
const brief = (error: string) => (error.split("\n")[0] ?? "").slice(0, 240);

export function createNodeHealth(o: {
  intervalS: number;
  maxBackoffS?: number;
  now?: () => number;
  log?: (line: string) => void;
}) {
  const now = o.now ?? Date.now;
  const max = Math.max(o.intervalS, o.maxBackoffS ?? DEFAULT_MAX_BACKOFF_S);
  const nodes = new Map<string, NodeHealth>();
  const nextTry = new Map<string, number>();
  return {
    /** Whether a sync with this node should be attempted now. */
    due: (node: string) => now() >= (nextTry.get(node) ?? 0),
    record(node: string, r: { ok: true } | { ok: false; error: string }) {
      const prev = nodes.get(node);
      const at = new Date(now()).toISOString();
      if (r.ok) {
        if (prev && !prev.ok)
          o.log?.(`node ${node} reachable again (was unreachable since ${prev.since})`);
        nodes.set(node, { ok: true, failures: 0, last_ok_at: at });
        nextTry.delete(node);
        return;
      }
      const failures = (prev?.failures ?? 0) + 1;
      const wait = Math.min(max, o.intervalS * 2 ** (failures - 1));
      const since = prev && !prev.ok && prev.since ? prev.since : at;
      const error = brief(r.error);
      // One line per outage, and another only when the reason changes.
      if (!prev || prev.ok || prev.error !== error)
        o.log?.(
          `node ${node} unreachable since ${since}: ${error} (retrying with backoff; heph doctor explains)`,
        );
      nextTry.set(node, now() + wait * 1000);
      nodes.set(node, {
        ok: false,
        failures,
        since,
        error,
        ...(prev?.last_ok_at ? { last_ok_at: prev.last_ok_at } : {}),
        next_try_at: new Date(now() + wait * 1000).toISOString(),
      });
    },
    snapshot: (): Record<string, NodeHealth> => Object.fromEntries(nodes),
  };
}
