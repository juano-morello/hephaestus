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

const unresolvedReason = (a: Ancestor) =>
  `stacked on ${a.runId}, which is ${a.status ?? "unknown"}: wait for it to be built again, or rebuild this run`;

/**
 * Why a stack has no known base, if it has none: an ancestor that is neither unmerged (built,
 * staged) nor landed (finished), e.g. revised back to planned, paused mid-rebuild or cancelled.
 */
export function unresolvedStack(ancestors: readonly Ancestor[]): string | undefined {
  const bad = ancestors.find(
    (a) => !a.status || (a.status !== "finished" && !STACKABLE.has(a.status)),
  );
  return bad ? unresolvedReason(bad) : undefined;
}

/** Thrown where a base is needed but the stack has none (see unresolvedStack). */
export class UnresolvedStack extends Error {
  override name = "UnresolvedStack";
}

/**
 * The branch a stacked run builds on in this repo: the nearest ancestor that is unmerged (built
 * or staged) and has a branch here. A parent's branch holds its ancestors' work only in repos it
 * touched itself, so a repo it skipped falls through to the next ancestor; a landed (finished)
 * ancestor is skipped too, since its work is in the target. None: the target is the base. Any
 * other ancestor status throws UnresolvedStack: the base is unknown, never silently the target.
 */
export async function ancestorBranch(
  git: Git,
  ancestors: readonly Ancestor[],
): Promise<string | undefined> {
  for (const a of ancestors) {
    if (a.status === "finished") continue;
    if (!a.status || !STACKABLE.has(a.status)) throw new UnresolvedStack(unresolvedReason(a));
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
export async function ancestorRefs(o: StackInput): Promise<Record<string, string>> {
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
          ancestors: o.ancestors,
          target: o.targets?.[r] ?? "main",
        });
  }
  return refs;
}
