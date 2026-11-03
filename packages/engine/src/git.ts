import { runOk } from "@hephaestus/sandbox";

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
};

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
  };
}
