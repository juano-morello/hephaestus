// Stacked runs (design 3.1): a run built on another run's branch instead of the target.
import { resolve } from "node:path";
import type { Workspace } from "@hephaestus/core";
import type { Ledger } from "@hephaestus/ledger";
import { runBranch, targetBase } from "./engine.ts";
import { createGit, type Git } from "./git.ts";

/** A parent run can be built on only while its changeset is built or staged (not yet landed). */
export const STACKABLE = new Set(["built", "staged"]);

/** The run a run is stacked on, and that run's status, from the ledger. */
export function parentOf(
  ledger: Ledger,
  runId: string,
  stackOn?: string,
): { stackOn?: string; parentStatus?: string } {
  const parent = stackOn ?? ledger.run(runId)?.stack_on ?? undefined;
  if (!parent) return {};
  const status = ledger.run(parent)?.status;
  return { stackOn: parent, ...(status ? { parentStatus: status } : {}) };
}

/**
 * The parent's branch in this repo, if the run builds on it there: the parent is unmerged and
 * touched the repo. A chain needs only the direct parent: its branch already holds its ancestors.
 */
export async function parentBranch(
  git: Git,
  stackOn: string | undefined,
  parentStatus: string | undefined,
): Promise<string | undefined> {
  if (!stackOn || !parentStatus || !STACKABLE.has(parentStatus)) return undefined;
  const branch = runBranch(stackOn);
  return (await git.refSha(branch)) ? branch : undefined;
}

/** Where a run's work in a repo starts: the parent's branch (see parentBranch), else the target. */
export async function baseRef(o: {
  git: Git;
  repo: string;
  stackOn?: string | undefined;
  parentStatus?: string | undefined;
  target: string;
}): Promise<string> {
  return (await parentBranch(o.git, o.stackOn, o.parentStatus)) ?? targetBase(o.git, o.target);
}

type StackInput = {
  workspace: Workspace;
  workspaceRoot: string;
  stackOn?: string | undefined;
  parentStatus?: string | undefined;
};

/** Per repo the parent's branch is in (see parentBranch): what planning reads files from. */
export async function parentRefs(o: StackInput): Promise<Record<string, string>> {
  const refs: Record<string, string> = {};
  for (const [r, path] of Object.entries(o.workspace.repos)) {
    const branch = await parentBranch(
      createGit(resolve(o.workspaceRoot, path)),
      o.stackOn,
      o.parentStatus,
    );
    if (branch) refs[r] = branch;
  }
  return refs;
}

/**
 * What the integration gate assembles: touched repos at the run's branch, the rest at the
 * parent's branch where it has one, else at their target.
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
          stackOn: o.stackOn,
          parentStatus: o.parentStatus,
          target: o.targets?.[r] ?? "main",
        });
  }
  return refs;
}
