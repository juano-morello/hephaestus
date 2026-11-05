import { resolve } from "node:path";
import type { Workspace } from "@hephaestus/core";
import { createGit } from "./git.ts";
import { projectRelative } from "./paths.ts";

/** Tracked files per project, project-relative: the input the plan gates check scopes against. */
export async function projectFiles(
  workspace: Workspace,
  workspaceRoot: string,
  /** Per repo, a ref to read files from instead of the checkout (e.g. a parent run's branch). */
  refs: Record<string, string> = {},
): Promise<Record<string, string[]>> {
  const byRepo = new Map<string, string[]>();
  for (const [repo, path] of Object.entries(workspace.repos)) {
    const dir = resolve(workspaceRoot, path);
    const git = createGit(dir);
    const ref = refs[repo];
    byRepo.set(repo, ref ? await git.lsTree(ref) : await git.lsFiles(dir));
  }
  return Object.fromEntries(
    Object.entries(workspace.projects).map(([name, p]) => [
      name,
      (byRepo.get(p.repo) ?? []).flatMap((f) => projectRelative(p.path, f) ?? []).sort(),
    ]),
  );
}
