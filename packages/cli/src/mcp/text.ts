// Plain-text renderers for MCP tool results, in the CLI's words (see main.ts).
import type { z } from "zod";
import { type OUTPUT, explainText as renderExplain } from "../output.ts";
import type { Outcome, WatchStepResult } from "./watch.ts";

type PlanShow = z.infer<(typeof OUTPUT)["plan show"]>;
type Status = z.infer<(typeof OUTPUT)["status"]>;
type Explain = z.infer<(typeof OUTPUT)["explain"]>;
type PlanResult = z.infer<(typeof OUTPUT)["new"]>;
type Hint = z.infer<(typeof OUTPUT)["hint"]>;
type Cancelled = z.infer<(typeof OUTPUT)["cancel"]>;
type Tasks = PlanShow["tasks"];

export const tasksText = (tasks: Tasks = []): string =>
  tasks
    .map(
      (t) =>
        `  ${t.id} ${t.kind} ${t.project} (${t.lane}): ${t.title}\n      changes ${t.scope.join(", ")}${t.covers.length ? `; covers ${t.covers.join(", ")}` : ""}`,
    )
    .join("\n");

export const planShowText = (p: PlanShow): string =>
  [
    `plan ${p.plan_id} of ${p.run_id} (${p.approved ? "approved" : "not approved"})`,
    tasksText(p.tasks),
    `order: ${p.order.join(" -> ")}`,
    ...p.risks.map((r) => `risk: ${r}`),
    ...(p.approved
      ? []
      : [
          `next: the user approves the plan (heph approve plan ${p.run_id}) — never approve it yourself`,
        ]),
    "",
  ].join("\n");

export const statusText = (s: Status): string => {
  if ("runs" in s)
    return `${s.runs.map((r) => `${r.run_id}  ${r.status}  ${String(r.updated_at ?? "")}`).join("\n") || "no runs"}\n`;
  return [
    `run ${s.run.run_id}: ${s.run.status}${s.plan_approved ? "" : " (plan not approved)"}`,
    ...s.units.map(
      (u) => `  ${u.unit_id} ${u.status} (${u.attempts} attempt${u.attempts === 1 ? "" : "s"})`,
    ),
    ...s.usage.map(
      (u) => `  ${u.model}: in ${u.input ?? 0} out ${u.output ?? 0} cache ${u.cache_read ?? 0}`,
    ),
    ...Object.entries(s.prs ?? {}).map(([repo, url]) => `  ${repo}: ${url}`),
    ...(s.stale ? [`stale: ${s.stale}`] : []),
    "",
  ].join("\n");
};

export const explainText = (x: Explain): string => renderExplain(x);

/** What a planning run (new, plan revise) came to; only a planned run asks for the user's approval. */
export const planResultText = (r: PlanResult): string =>
  `${[
    `run ${r.run_id}: ${r.status} after ${r.planner_attempts} planner attempt(s)${r.node ? ` on ${r.node}` : ""}`,
    ...(r.tasks?.length ? [tasksText(r.tasks)] : []),
    ...(r.escalate ?? []).map((x) => `  - ${x}`),
    ...(r.reason ? [`  ${r.reason}`] : []),
    ...(r.status === "planned"
      ? [
          `next: show the plan to the user (heph_plan_show) and wait for them to approve it; the user runs heph approve plan ${r.run_id} themselves — never approve it yourself`,
        ]
      : []),
  ].join("\n")}\n`;

export const hintText = (h: Hint): string =>
  `recorded ${h.recorded.join(" and ")} for ${h.unit} in ${h.run_id}${h.scope ? ` (it may also change ${h.scope.join(", ")})` : ""}\n`;

export const cancelText = (c: Cancelled): string => `cancelled ${c.run_id}\n`;

/** What the agent does after a watch step, per outcome. Approvals are always the user's. */
export const nextFor = (
  outcome: Outcome,
  runId: string,
  cursor: string | undefined,
  stack: { waiting_for?: string | undefined; blocked?: string | undefined } = {},
): string => {
  switch (outcome) {
    case "running":
      return cursor
        ? `call heph_watch again with since ${cursor}`
        : "call heph_watch again with since omitted, after a pause; do not loop tightly";
    case "awaiting_plan_approval":
      return `ask the user to run \`heph approve plan ${runId}\` themselves — never approve it yourself`;
    case "waiting_for_you":
    case "planner_escalated":
      return "explain to the user and ask; do not retry";
    case "waiting_for_parent":
      return `wait for ${stack.waiting_for ?? "its parent"}: tell the user to merge it first (\`heph approve merge ${stack.waiting_for ?? "<parent>"}\`, themselves); then ${runId} is restacked and the user approves it`;
    case "blocked_by_parent":
      return `explain to the user that its parent cannot land, so ${runId} has to be rebuilt; ask; do not retry`;
    case "staged":
      return `tell the user to review, then run \`heph approve merge ${runId}\` themselves`;
    case "finished":
      return "tell the user the run finished";
    case "failed":
      return "explain to the user and ask; do not retry";
  }
};

export const watchText = (w: WatchStepResult): string =>
  `${[
    ...w.lines,
    `run ${w.run_id}: ${w.status} (${w.outcome})${w.cursor ? `, cursor ${w.cursor}` : ""}`,
    `next: ${nextFor(w.outcome, w.run_id, w.cursor, w)}`,
  ].join("\n")}\n`;

export type RunState = "awaiting_plan_approval" | "started" | "already_running" | "not_runnable";

export const runText = (r: {
  run_id: string;
  state: RunState;
  status: string;
  lines: string[];
  cursor?: string;
  outcome?: Outcome;
  waiting_for?: string | undefined;
  blocked?: string | undefined;
}): string => {
  if (r.state === "awaiting_plan_approval")
    return `run ${r.run_id} is not running: its plan is not approved\nnext: ask the user to run \`heph approve plan ${r.run_id}\` themselves — never approve it yourself\n`;
  const head =
    r.state === "not_runnable"
      ? `run ${r.run_id} was not started: it is ${r.status}`
      : `run ${r.run_id}: ${r.state === "started" ? "started" : "already running"} (${r.status})`;
  if (r.state === "not_runnable" && (!r.outcome || r.outcome === "running"))
    return `${[
      `run ${r.run_id} was not started: it is ${r.status} and has no plan to build`,
      ...r.lines,
      `next: check it with heph_status, or plan it with heph_plan_revise`,
    ].join("\n")}\n`;
  const stopped = r.outcome && r.outcome !== "running";
  return `${[
    head,
    ...r.lines,
    ...(stopped && r.state !== "not_runnable" ? [`it has already stopped: ${r.outcome}`] : []),
    stopped
      ? `next: ${nextFor(r.outcome as Outcome, r.run_id, r.cursor, r)}`
      : `next: follow it with heph_watch${r.cursor ? ` (since ${r.cursor})` : ""}`,
  ].join("\n")}\n`;
};
