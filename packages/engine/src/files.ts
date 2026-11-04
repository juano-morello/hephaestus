import { resolve } from "node:path";
import type { Workspace } from "@hephaestus/core";
import { createGit } from "./git.ts";
import { projectRelative } from "./paths.ts";

/** Tracked files per project, project-relative: the input the plan gates check scopes against. */
export async function projectFiles(
  workspace: Workspace,
  workspaceRoot: string,
): Promise<Record<string, string[]>> {
  const byRepo = new Map<string, string[]>();
  for (const [repo, path] of Object.entries(workspace.repos)) {
    const dir = resolve(workspaceRoot, path);
    byRepo.set(repo, await createGit(dir).lsFiles(dir));
  }
  return Object.fromEntries(
    Object.entries(workspace.projects).map(([name, p]) => [
      name,
      (byRepo.get(p.repo) ?? []).flatMap((f) => projectRelative(p.path, f) ?? []).sort(),
    ]),
  );
}
