// Plain-text renderers for MCP tool results, in the CLI's words (see main.ts).
import type { z } from "zod";
import type { OUTPUT } from "../output.ts";

type PlanShow = z.infer<(typeof OUTPUT)["plan show"]>;
type Status = z.infer<(typeof OUTPUT)["status"]>;
type Explain = z.infer<(typeof OUTPUT)["explain"]>;
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

export const explainText = (x: Explain): string =>
  `${x.events
    .map(
      (e) =>
        `${e.ts.slice(11, 19)} ${e.unit_id ? `${e.unit_id}${e.attempt ? `/a${e.attempt}` : ""} ` : ""}${e.summary}`,
    )
    .join("\n")}\n`;
