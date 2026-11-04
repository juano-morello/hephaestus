import { run, runOk } from "@hephaestus/sandbox";

/** Engine commits carry their own identity, so they never depend on the repo's git config. */
const IDENTITY = ["-c", "user.name=Hephaestus", "-c", "user.email=heph@localhost"];

export type Diff = { files: string[]; text: string };

export type Git = {
  revParse(ref: string): Promise<string>;
  /** Creates the branch at `at`, or resets it there. */
  branchForce(branch: string, at: string): Promise<void>;
  /** Checks out `branch` reset to `at` in a new worktree. */
  worktreeAdd(path: string, branch: string, at: string): Promise<void>;
  worktreeRemove(path: string): Promise<void>;
  /** Stages everything and commits, even when nothing changed. Returns the commit sha. */
  commitAll(worktree: string, message: string): Promise<string>;
  diff(from: string, to: string): Promise<Diff>;
  /** Moves `refs/heads/<branch>` to `next` only if it currently points at `expected`. */
  updateRef(branch: string, next: string, expected: string): Promise<void>;
  lsFiles(worktree: string): Promise<string[]>;
  /** The remote's url, or undefined when the repo has no such remote. */
  remoteUrl(remote: string): Promise<string | undefined>;
  /** Updates `<remote>/<branch>`. */
  fetch(remote: string, branch: string): Promise<void>;
  /** The sha of `refs/heads/<branch>` on the remote, or undefined if it doesn't exist there. */
  remoteRef(remote: string, branch: string): Promise<string | undefined>;
  /** Pushes `from` to the remote branch only if it still points at `expected` (undefined: absent). */
  pushWithLease(
    remote: string,
    from: string,
    branch: string,
    expected: string | undefined,
  ): Promise<void>;
  worktreeAddDetached(path: string, ref: string): Promise<void>;
  mergeBase(a: string, b: string): Promise<string>;
  /** Points any ref (e.g. refs/heph/staging/<run>) at a sha. */
  setRef(ref: string, sha: string): Promise<void>;
  /** Rebases `branch` onto `onto` in a temp worktree at `path`. On conflict the branch is untouched. */
  rebase(path: string, branch: string, onto: string): Promise<RebaseResult>;
};

export type RebaseResult = { ok: true; sha: string } | { ok: false; conflicts: string[] };

const lines = (s: string) => s.split("\n").filter(Boolean);

export function createGit(repoDir: string): Git {
  const git = (args: string[], cwd = repoDir) => runOk(["git", ...args], { cwd });
  return {
    revParse: async (ref) => (await git(["rev-parse", "--verify", `${ref}^{commit}`])).trim(),
    branchForce: async (branch, at) => void (await git(["branch", "-f", branch, at])),
    worktreeAdd: async (path, branch, at) =>
      void (await git(["worktree", "add", "-q", "-f", "-B", branch, path, at])),
    worktreeRemove: async (path) => {
      await git(["worktree", "remove", "--force", path]);
      await git(["worktree", "prune"]);
    },
    commitAll: async (worktree, message) => {
      await git(["add", "-A"], worktree);
      await git(
        [...IDENTITY, "commit", "-q", "--allow-empty", "--no-verify", "-m", message],
        worktree,
      );
      return (await git(["rev-parse", "HEAD"], worktree)).trim();
    },
    diff: async (from, to) => ({
      files: lines(await git(["diff", "--no-renames", "--name-only", from, to])),
      text: await git(["diff", "--no-renames", from, to]),
    }),
    updateRef: async (branch, next, expected) =>
      void (await git(["update-ref", `refs/heads/${branch}`, next, expected])),
    lsFiles: async (worktree) => lines(await git(["ls-files"], worktree)),
    async remoteUrl(remote) {
      const r = await run(["git", "remote", "get-url", remote], { cwd: repoDir });
      return r.code === 0 ? r.stdout.trim() : undefined;
    },
    fetch: async (remote, branch) => void (await git(["fetch", "-q", remote, branch])),
    async remoteRef(remote, branch) {
      const out = await git(["ls-remote", remote, `refs/heads/${branch}`]);
      return out.split(/\s+/)[0] || undefined;
    },
    pushWithLease: async (remote, from, branch, expected) =>
      void (await git([
        "push",
        "-q",
        `--force-with-lease=refs/heads/${branch}:${expected ?? ""}`,
        remote,
        `${from}:refs/heads/${branch}`,
      ])),
    worktreeAddDetached: async (path, ref) =>
      void (await git(["worktree", "add", "-q", "-f", "--detach", path, ref])),
    mergeBase: async (a, b) => (await git(["merge-base", a, b])).trim(),
    setRef: async (ref, sha) => void (await git(["update-ref", ref, sha])),
    async rebase(path, branch, onto) {
      await git(["worktree", "add", "-q", "-f", path, branch]);
      try {
        const r = await run(["git", ...IDENTITY, "rebase", "-q", onto], { cwd: path });
        if (r.code === 0) return { ok: true, sha: (await git(["rev-parse", "HEAD"], path)).trim() };
        const conflicts = lines(await git(["diff", "--name-only", "--diff-filter=U"], path));
        await run(["git", "rebase", "--abort"], { cwd: path });
        return { ok: false, conflicts };
      } finally {
        await git(["worktree", "remove", "--force", path]);
        await git(["worktree", "prune"]);
      }
    },
  };
}
