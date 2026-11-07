// A throwaway workspace for one eval run: each repo cloned at its pinned commit with every remote
// removed, so nothing a run does can push, open a pull request or touch the real repo.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EvalTask, Workspace } from "@hephaestus/core";

/** The branch the run builds on and stages against: the pin. */
export const EVAL_BASE = "eval-base";

/** `git` with an explicit directory; a write command never runs in the real repo's directory. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${err.trim()}`);
  return out;
}

/** A local clone that shares nothing with its source (no hardlinks, no remote). */
export async function cloneLocal(
  src: string,
  dst: string,
  opts: { branch?: string } = {},
): Promise<void> {
  mkdirSync(resolve(dst, ".."), { recursive: true });
  await git(
    resolve(dst, ".."),
    "clone",
    "--no-hardlinks",
    "--quiet",
    ...(opts.branch ? ["--branch", opts.branch] : []),
    resolve(src),
    dst,
  );
  await dropRemotes(dst);
}

async function dropRemotes(dir: string): Promise<void> {
  const remotes = (await git(dir, "remote")).split("\n").filter(Boolean);
  for (const name of remotes) await git(dir, "remote", "remove", name);
}

export async function prepareEvalWorkspace(o: {
  suiteDir: string;
  workspace: Workspace;
  task: EvalTask;
  dir: string;
}): Promise<{
  workspaceDir: string;
  repoDirs: Record<string, string>;
  base: Record<string, string>;
}> {
  const repoDirs: Record<string, string> = {};
  const base: Record<string, string> = {};
  for (const [repo, sha] of Object.entries(o.task.workspace_ref)) {
    const source = o.workspace.repos[repo];
    if (!source) throw new Error(`eval ${o.task.id}: repo ${repo} is not in the workspace`);
    const real = resolve(o.suiteDir, source);
    const dir = join(o.dir, repo);
    await cloneLocal(real, dir);
    await git(dir, "checkout", "-q", "-B", EVAL_BASE, sha);
    repoDirs[repo] = dir;
    base[repo] = sha;

    // The suite's own config for the repo, else what the real checkout has (often uncommitted).
    const suiteConfig = join(o.suiteDir, "repo-configs", `${repo}.yaml`);
    const realConfig = join(real, ".heph", "config.yaml");
    const from = existsSync(suiteConfig) ? suiteConfig : existsSync(realConfig) ? realConfig : "";
    if (from) {
      mkdirSync(join(dir, ".heph"), { recursive: true });
      copyFileSync(from, join(dir, ".heph", "config.yaml"));
    }
  }

  // The workspace is the suite's, cut to the repos this task pins (the others have no clone).
  const pinned = new Set(Object.keys(repoDirs));
  const projects = Object.fromEntries(
    Object.entries(o.workspace.projects)
      .filter(([, p]) => pinned.has(p.repo))
      .map(([name, p]) => {
        const kept = p.depends_on?.filter((d) => {
          const dep = o.workspace.projects[d];
          return dep !== undefined && pinned.has(dep.repo);
        });
        const { depends_on: _drop, ...rest } = p;
        return [name, kept?.length ? { ...rest, depends_on: kept } : rest];
      }),
  );
  const workspaceFile = {
    ...o.workspace,
    name: `eval-${o.task.id}`,
    repos: Object.fromEntries([...pinned].map((r) => [r, `./${r}`])),
    projects,
    targets: Object.fromEntries([...pinned].map((r) => [r, EVAL_BASE])),
  };
  mkdirSync(join(o.dir, ".heph"), { recursive: true });
  // JSON is YAML.
  writeFileSync(
    join(o.dir, ".heph", "workspace.yaml"),
    `${JSON.stringify(workspaceFile, null, 2)}\n`,
  );
  return { workspaceDir: o.dir, repoDirs, base };
}
