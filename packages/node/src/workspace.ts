import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { WorkspaceConfig } from "@hephaestus/core";
import { createGit, type PullRequests, runBranch } from "@hephaestus/engine";
import { run, runOk } from "@hephaestus/sandbox";
import { type Methods, PeerError } from "./protocol.ts";

const REMOTE = "origin";

/** What another node needs to make its own checkout of a workspace (SPEC section 7). */
export type WorkspaceDescription = {
  name: string;
  /** `.heph/workspace.yaml` as written, or undefined for an implied single-repo workspace. */
  workspaceYaml?: string | undefined;
  repos: Record<string, { path: string; url: string; config?: string | undefined }>;
};

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : undefined);

/** Describes this node's checkout. Git is the code transport, so every repo needs a remote. */
export async function describeWorkspace(
  workspaceDir: string,
  workspace: WorkspaceConfig & { name?: string | undefined },
): Promise<WorkspaceDescription> {
  if (!workspace.name) throw new Error("the workspace has no name");
  const repos: WorkspaceDescription["repos"] = {};
  const missing: string[] = [];
  for (const [repo, path] of Object.entries(workspace.repos)) {
    const dir = resolve(workspaceDir, path);
    const url = await createGit(dir).remoteUrl(REMOTE);
    if (!url) {
      missing.push(repo);
      continue;
    }
    repos[repo] = { path, url, config: read(join(dir, ".heph", "config.yaml")) };
  }
  if (missing.length)
    throw new Error(
      `a run on another node needs every repo to have a remote named ${REMOTE}; missing in ${missing.join(", ")}`,
    );
  return {
    name: workspace.name,
    workspaceYaml: read(join(workspaceDir, ".heph", "workspace.yaml")),
    repos,
  };
}

/**
 * This node's checkout of a named workspace: `workspaces.<name>` from its config, else
 * `<home>/workspaces/<name>`. Repos it lacks are cloned from their remotes. The heph files that
 * aren't committed (workspace.yaml, each repo's .heph/config.yaml) come from the sender: a
 * checkout heph made takes them every time, so the node runs with the sender's current config;
 * a checkout you configured is yours, and gets them only where it has none. `written` lists the
 * files written, relative to the checkout.
 */
export async function ensureWorkspace(
  desc: WorkspaceDescription,
  opts: { home: string; workspaces: Record<string, string> },
): Promise<{ dir: string; cloned: string[]; written: string[] }> {
  const configured = opts.workspaces[desc.name];
  const dir = resolve(configured ?? join(opts.home, "workspaces", desc.name));
  const cloned: string[] = [];
  // Root repo first: git clone needs an empty directory.
  const repos = Object.entries(desc.repos).sort(([, a], [, b]) =>
    a.path === "." ? -1 : b.path === "." ? 1 : 0,
  );
  for (const [repo, r] of repos) {
    const target = resolve(dir, r.path);
    if (existsSync(join(target, ".git"))) continue;
    mkdirSync(target, { recursive: true });
    await runOk(["git", "clone", "-q", r.url, target]);
    cloned.push(repo);
  }
  const written: string[] = [];
  const put = (file: string, text: string | undefined) => {
    if (text === undefined) return;
    if (existsSync(file) && (configured || read(file) === text)) return;
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
    written.push(relative(dir, file));
  };
  put(join(dir, ".heph", "workspace.yaml"), desc.workspaceYaml);
  for (const r of Object.values(desc.repos))
    put(join(resolve(dir, r.path), ".heph", "config.yaml"), r.config);
  return { dir, cloned, written };
}

/** What a node checks about pull requests before it takes a run (only `preflight` is used). */
export type Preflight = Pick<PullRequests, "preflight">;

/**
 * What would stop a run on this checkout from landing, one line per problem: each repo's
 * remote must take a push (checked with a dry run, which asks for credentials), and the pull
 * request client must be able to open pull requests there. Empty when nothing would.
 */
export async function checkWorkspace(
  dir: string,
  desc: WorkspaceDescription,
  opts: { prs?: Preflight | undefined } = {},
): Promise<string[]> {
  const problems: string[] = [];
  for (const [repo, r] of Object.entries(desc.repos)) {
    const cwd = resolve(dir, r.path);
    const url = (await createGit(cwd).remoteUrl(REMOTE)) ?? r.url;
    const head = (await run(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
    const push = await run(
      ["git", "push", "--dry-run", "-q", REMOTE, `${head}:refs/heads/heph/preflight`],
      { cwd, env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 60_000 },
    );
    if (push.code !== 0)
      problems.push(
        `${repo}: can't push to ${url}: ${push.timedOut ? "timed out" : push.stderr.trim().split("\n").at(-1)}`,
      );
    const pr = await opts.prs?.preflight?.({ repoDir: cwd });
    if (pr) problems.push(`${repo}: ${pr}`);
  }
  return problems;
}

/** Makes this node's checkout of a workspace, then refuses it if a run there couldn't land. */
export async function prepareWorkspace(
  desc: WorkspaceDescription,
  opts: {
    node: string;
    home: string;
    workspaces: Record<string, string>;
    prs?: Preflight | undefined;
  },
): Promise<{ dir: string; cloned: string[]; written: string[] }> {
  const out = await ensureWorkspace(desc, opts);
  const problems = await checkWorkspace(out.dir, desc, opts);
  if (problems.length)
    throw new PeerError(
      `${opts.node} can't take workspace ${desc.name}:\n  ${problems.join("\n  ")}`,
    );
  return out;
}

/**
 * A node's workspace peer methods: `workspace.ensure`, asked before a run is given to this node,
 * and `workspace.files`, which brings the sender's heph files before a command it forwards.
 */
export function workspaceMethods(opts: Parameters<typeof prepareWorkspace>[1]): Methods {
  return {
    "workspace.ensure": (p: { workspace: WorkspaceDescription }) =>
      prepareWorkspace(p.workspace, opts),
    "workspace.files": (p: { workspace: WorkspaceDescription }) =>
      ensureWorkspace(p.workspace, opts),
  };
}

/**
 * Brings a run's branches from the remotes into this node's checkout, for a node taking the
 * run over. Repos whose remote has no such branch (the run didn't touch them) are skipped.
 */
export async function fetchRunBranches(
  workspaceDir: string,
  workspace: Pick<WorkspaceConfig, "repos">,
  runId: string,
): Promise<string[]> {
  const branch = runBranch(runId);
  const fetched: string[] = [];
  for (const [repo, path] of Object.entries(workspace.repos)) {
    const git = createGit(resolve(workspaceDir, path));
    if (!(await git.remoteUrl(REMOTE))) continue;
    if (!(await git.remoteRef(REMOTE, branch))) continue;
    await runOk(["git", "fetch", "-q", REMOTE, `+refs/heads/${branch}:refs/heads/${branch}`], {
      cwd: resolve(workspaceDir, path),
    });
    fetched.push(repo);
  }
  return fetched;
}
