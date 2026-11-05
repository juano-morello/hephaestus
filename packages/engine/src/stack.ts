// Stacked runs (design 3.1): a run built on another run's branch instead of the target.
import { resolve } from "node:path";
import type { Workspace } from "@hephaestus/core";
import type { Ledger } from "@hephaestus/ledger";
import { runBranch, targetBase } from "./engine.ts";
import { createGit, type Git } from "./git.ts";

/** A parent run can be built on only while its changeset is built or staged (not yet landed). */
export const STACKABLE = new Set(["built", "staged"]);

/** One run up a stack: its id and status. */
export type Ancestor = { runId: string; status?: string | undefined };

/**
 * The runs a run is stacked on, nearest first: its parent (`stackOn`, else its recorded
 * `stack_on`), the parent's parent, and so on up to a run with no `stack_on`.
 */
export function ancestorsOf(ledger: Ledger, runId: string, stackOn?: string): Ancestor[] {
  const out: Ancestor[] = [];
  const seen = new Set([runId]);
  let next = stackOn ?? ledger.run(runId)?.stack_on ?? undefined;
  while (next && !seen.has(next)) {
    seen.add(next);
    const row = ledger.run(next);
    out.push({ runId: next, status: row?.status });
    next = row?.stack_on ?? undefined;
  }
  return out;
}

/**
 * The branch a stacked run builds on in this repo: the nearest ancestor that is unmerged (built
 * or staged) and has a branch here. A parent's branch holds its ancestors' work only in repos it
 * touched itself, so a repo it skipped falls through to the next ancestor; a landed (finished)
 * ancestor is skipped too, since its work is in the target. None: the target is the base.
 */
export async function ancestorBranch(
  git: Git,
  ancestors: readonly Ancestor[],
): Promise<string | undefined> {
  for (const a of ancestors) {
    if (!a.status || !STACKABLE.has(a.status)) continue;
    const branch = runBranch(a.runId);
    if (await git.refSha(branch)) return branch;
  }
  return undefined;
}

/**
 * Where a run's work in a repo starts: the nearest qualifying ancestor's branch (see
 * ancestorBranch), else the target. `stackOn`/`parentStatus` is shorthand for a one-run chain.
 */
export async function baseRef(o: {
  git: Git;
  repo: string;
  stackOn?: string | undefined;
  parentStatus?: string | undefined;
  ancestors?: readonly Ancestor[] | undefined;
  target: string;
}): Promise<string> {
  const chain = o.ancestors ?? (o.stackOn ? [{ runId: o.stackOn, status: o.parentStatus }] : []);
  return (await ancestorBranch(o.git, chain)) ?? targetBase(o.git, o.target);
}

type StackInput = {
  workspace: Workspace;
  workspaceRoot: string;
  ancestors: readonly Ancestor[];
};

/** Per repo that has an ancestor's branch (see ancestorBranch): what planning reads files from. */
export async function parentRefs(o: StackInput): Promise<Record<string, string>> {
  const refs: Record<string, string> = {};
  for (const [r, path] of Object.entries(o.workspace.repos)) {
    const branch = await ancestorBranch(createGit(resolve(o.workspaceRoot, path)), o.ancestors);
    if (branch) refs[r] = branch;
  }
  return refs;
}

/**
 * What the integration gate assembles: touched repos at the run's branch, the rest at the
 * nearest ancestor's branch where one qualifies, else at their target.
 */
export async function stackRefs(
  o: StackInput & {
    runId: string;
    touched: string[];
    targets?: Record<string, string> | undefined;
  },
): Promise<Record<string, string>> {
  const refs: Record<string, string> = {};
  for (const [r, path] of Object.entries(o.workspace.repos)) {
    refs[r] = o.touched.includes(r)
      ? runBranch(o.runId)
      : await baseRef({
          git: createGit(resolve(o.workspaceRoot, path)),
          repo: r,
          ancestors: o.ancestors,
          target: o.targets?.[r] ?? "main",
        });
  }
  return refs;
}
