import { briefGate } from "../gates/brief.ts";
import type { Brief } from "../schemas/brief.ts";
import type { EvalTask } from "../schemas/eval.ts";
import type { ProjectGates } from "../schemas/gates.ts";
import type { Workspace } from "../schemas/workspace.ts";

/** needs_oracle: well-formed, but the user has not written the hidden tests yet. */
export type EvalStatus = "ready" | "needs_oracle" | "invalid";
export type EvalCheck = { id: string; status: EvalStatus; issues: string[] };

export type EvalCheckContext = {
  workspace: Workspace;
  projectGates: ProjectGates;
  brief?: Brief;
  briefError?: string;
  hiddenTestExists: (from: string) => boolean;
};

export function checkEvalTask(task: EvalTask, ctx: EvalCheckContext): EvalCheck {
  const invalid: string[] = [];
  const missing: string[] = [];
  const { projects, repos } = ctx.workspace;

  if (!ctx.brief) invalid.push(`brief: ${ctx.briefError ?? "not loaded"}`);
  else {
    const gate = briefGate(ctx.brief, ctx.workspace, ctx.projectGates);
    for (const e of gate.evidence) invalid.push(`brief gate: ${e}`);
  }

  for (const repo of Object.keys(task.workspace_ref)) {
    if (!(repo in repos)) invalid.push(`workspace_ref: repo "${repo}" is not in the workspace`);
  }

  const oracle = task.oracle;
  const oracleProjects = oracle
    ? [...oracle.hidden_tests, ...oracle.must_pass, ...oracle.must_not_touch].map((e) => e.project)
    : [];
  for (const p of new Set(oracleProjects)) {
    if (!(p in projects)) invalid.push(`oracle: project "${p}" is not in the workspace`);
  }

  // Every repo the task can touch must be pinned, or the run is not reproducible.
  const touched = new Set([
    ...oracleProjects,
    ...(ctx.brief?.known_paths ?? []).map((k) => k.project),
  ]);
  for (const p of touched) {
    const repo = projects[p]?.repo;
    if (repo && !(repo in task.workspace_ref)) {
      invalid.push(`workspace_ref: repo "${repo}" (project ${p}) is not pinned`);
    }
  }

  const landed = new Set<string>();
  for (const ht of oracle?.hidden_tests ?? []) {
    const dest = `${ht.project}:${ht.to}`;
    if (landed.has(dest)) invalid.push(`oracle: two hidden tests land on ${dest}`);
    landed.add(dest);
    if (!ctx.hiddenTestExists(ht.from)) missing.push(`oracle: hidden test ${ht.from} is missing`);
  }

  const status: EvalStatus = invalid.length ? "invalid" : missing.length ? "needs_oracle" : "ready";
  return { id: task.id, status, issues: [...invalid, ...missing] };
}
