// The hidden oracle of a golden task (SPEC section 14): applied to the run's result in a fresh
// checkout, after the run, and never shown to the harness.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { globsOverlap, type Oracle, type Workspace } from "@hephaestus/core";
import type { Sandbox } from "@hephaestus/sandbox";

const git = async (dir: string, ...args: string[]): Promise<string> => {
  const proc = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} in ${dir}: ${err.trim()}`);
  return out;
};

export async function checkOracle(o: {
  oracle: Oracle;
  taskDir: string;
  workspace: Workspace;
  /** A directory with the repo checked out at the run's result. */
  checkoutOf: (repo: string) => string;
  /** Repo name to the pinned sha the run started from. */
  base: Record<string, string>;
  /** Opens the sandbox for a project's directory (the project's own image, in a container). */
  sandboxOf: (hostDir: string, project: string) => Promise<Sandbox>;
  timeoutMs: number;
}): Promise<{ solved: boolean; failures: string[] }> {
  const failures: string[] = [];
  const project = (name: string) => {
    const p = o.workspace.projects[name];
    if (!p) throw new Error(`oracle: unknown project ${name}`);
    return { ...p, dir: join(o.checkoutOf(p.repo), p.path) };
  };

  // The diff comes first: the hidden tests copied below are the oracle's, not the run's.
  for (const entry of o.oracle.must_not_touch) {
    const p = project(entry.project);
    const sha = o.base[p.repo];
    if (!sha) throw new Error(`oracle: no pinned commit for repo ${p.repo}`);
    const changed = (
      await git(o.checkoutOf(p.repo), "diff", "--name-only", "--no-renames", `${sha}..HEAD`)
    )
      .split("\n")
      .filter(Boolean);
    const prefix = p.path === "." ? "" : `${p.path.replace(/^\.\//, "").replace(/\/+$/, "")}/`;
    for (const file of changed) {
      if (prefix && !file.startsWith(prefix)) continue;
      const rel = file.slice(prefix.length);
      if (entry.paths.some((glob) => globsOverlap(glob, rel)))
        failures.push(`must_not_touch ${entry.project}: ${rel}`);
    }
  }

  for (const ht of o.oracle.hidden_tests) {
    const to = join(project(ht.project).dir, ht.to);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(resolve(o.taskDir, ht.from), to);
  }

  for (const check of o.oracle.must_pass) {
    const sandbox = await o.sandboxOf(project(check.project).dir, check.project);
    try {
      const r = await sandbox.exec(check.run, { timeoutMs: o.timeoutMs });
      if (r.timedOut) failures.push(`must_pass ${check.project}: ${check.run} timed out`);
      else if (r.code !== 0)
        failures.push(`must_pass ${check.project}: ${check.run} exited ${r.code}`);
    } finally {
      await sandbox.dispose();
    }
  }
  return { solved: failures.length === 0, failures };
}
