// `heph nodes`: the rows, how the daemon's health snapshot is merged into them, and the table.
import type { NodeHealth } from "./node-health.ts";

export type NodeRow = {
  name: string;
  ssh: string;
  preferred: boolean;
  labels: string[];
  /** `unknown` without a daemon: only the daemon's sync loop knows whether a peer answers. */
  state: "ok" | "down" | "unknown";
  this_node?: boolean;
  since?: string;
  last_ok_at?: string;
  next_try_at?: string;
  error?: string;
  runs_owned: number;
  probe?: { ok: boolean; detail: string };
};

export type NodesResult = { nodes: NodeRow[]; daemon?: boolean };

/**
 * What the daemon adds to a method's answer from its node health: the peers' reachability for
 * `status` with no run, and the state of each row for `nodes`.
 */
export function mergeHealth(
  method: string,
  args: unknown[],
  data: unknown,
  health: Record<string, NodeHealth>,
): unknown {
  const d = data as Record<string, unknown> | null;
  if (method === "nodes" && d && Array.isArray(d.nodes)) {
    const nodes = (d.nodes as NodeRow[]).map((r) => {
      const h = health[r.name];
      if (r.this_node || !h) return r;
      return {
        ...r,
        state: h.ok ? ("ok" as const) : ("down" as const),
        ...(h.since ? { since: h.since } : {}),
        ...(h.last_ok_at ? { last_ok_at: h.last_ok_at } : {}),
        ...(h.next_try_at ? { next_try_at: h.next_try_at } : {}),
        ...(h.error ? { error: h.error } : {}),
      };
    });
    return { ...d, nodes, daemon: true };
  }
  const withNodes =
    method === "status" && !args[0] && Object.keys(health).length && d && !("run" in d);
  return withNodes ? { ...d, nodes: health } : data;
}

export function nodesText(r: NodesResult): string {
  const cells = r.nodes.map((n) => [
    n.this_node ? `${n.name} (this node)` : n.name,
    n.ssh,
    n.preferred ? "preferred" : "",
    n.labels.join(","),
    n.state,
    `${n.runs_owned} runs`,
    [
      n.state === "down" && n.error ? n.error : "",
      n.state === "down" && n.next_try_at ? `retry ${n.next_try_at}` : "",
      n.probe ? `probe: ${n.probe.detail}` : "",
    ]
      .filter(Boolean)
      .join("; "),
  ]);
  const widths = [0, 1, 2, 3, 4, 5].map((i) => Math.max(...cells.map((c) => (c[i] ?? "").length)));
  const lines = cells.map((c) =>
    c
      .map((cell, i) => (i < 6 ? cell.padEnd(widths[i] ?? 0) : cell))
      .join("  ")
      .trimEnd(),
  );
  if (r.nodes.some((n) => n.state === "unknown"))
    lines.push("state is unknown without a daemon (start heph daemon, or use --probe)");
  return `${lines.join("\n")}\n`;
}
