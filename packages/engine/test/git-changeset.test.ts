import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runOk } from "@hephaestus/sandbox";
import { createGit } from "../src/git.ts";
import { initRepo, tempDir, writeFiles } from "./helpers.ts";

const dir = tempDir();

/** A repo with a bare clone wired up as its origin. */
async function withOrigin() {
  const repo = await initRepo(dir(), { "a.txt": "one\n" });
  const origin = join(dir(), "origin.git");
  await runOk(["git", "clone", "-q", "--bare", repo, origin]);
  await runOk(["git", "remote", "add", "origin", origin], { cwd: repo });
  return { repo, origin, git: createGit(repo) };
}

/** Commits files on `branch` (created at `at`) in a throwaway worktree; returns the sha. */
async function commitOn(
  git: ReturnType<typeof createGit>,
  branch: string,
  at: string,
  files: Record<string, string>,
) {
  const wt = join(dir(), "wt");
  await git.worktreeAdd(wt, branch, at);
  writeFiles(wt, files);
  const sha = await git.commitAll(wt, `edit ${Object.keys(files).join(",")}`);
  await git.worktreeRemove(wt);
  return sha;
}

describe("git for changesets", () => {
  test("knows whether a repo has a remote", async () => {
    const { git, origin } = await withOrigin();
    expect(await git.remoteUrl("origin")).toBe(origin);
    const plain = createGit(await initRepo(dir(), { x: "x" }));
    expect(await plain.remoteUrl("origin")).toBeUndefined();
  });

  test("push with a lease creates a branch and refuses a stale lease", async () => {
    const { git } = await withOrigin();
    const main = await git.revParse("main");
    const first = await commitOn(git, "heph/R1", main, { "b.txt": "b\n" });
    expect(await git.remoteRef("origin", "heph/R1")).toBeUndefined();
    await git.pushWithLease("origin", first, "heph/R1", undefined);
    expect(await git.remoteRef("origin", "heph/R1")).toBe(first);
    const second = await commitOn(git, "heph/R1", first, { "c.txt": "c\n" });
    await expect(git.pushWithLease("origin", second, "heph/R1", main)).rejects.toThrow();
    await git.pushWithLease("origin", second, "heph/R1", first);
    expect(await git.remoteRef("origin", "heph/R1")).toBe(second);
  });

  test("fetch updates the remote-tracking branch", async () => {
    const { git, origin } = await withOrigin();
    const other = join(dir(), "other");
    await runOk(["git", "clone", "-q", origin, other]);
    writeFiles(other, { "d.txt": "d\n" });
    await runOk(
      ["git", "-c", "user.name=O", "-c", "user.email=o@x", "commit", "-qam", "d", "--allow-empty"],
      { cwd: other },
    );
    await runOk(["git", "add", "-A"], { cwd: other });
    await runOk(["git", "-c", "user.name=O", "-c", "user.email=o@x", "commit", "-qm", "d2"], {
      cwd: other,
    });
    await runOk(["git", "push", "-q", "origin", "main"], { cwd: other });
    await git.fetch("origin", "main");
    expect(await git.revParse("origin/main")).toBe(await git.remoteRef("origin", "main"));
  });

  test("a detached worktree at a ref, and merge-base", async () => {
    const { git } = await withOrigin();
    const main = await git.revParse("main");
    const tip = await commitOn(git, "heph/R1", main, { "b.txt": "b\n" });
    const wt = join(dir(), "detached");
    await git.worktreeAddDetached(wt, "heph/R1");
    expect(readFileSync(join(wt, "b.txt"), "utf8")).toBe("b\n");
    await git.worktreeRemove(wt);
    expect(await git.mergeBase("heph/R1", "main")).toBe(main);
    expect(tip).not.toBe(main);
  });

  test("rebase moves a branch onto a new base", async () => {
    const { git } = await withOrigin();
    const base = await git.revParse("main");
    await commitOn(git, "heph/R1", base, { "b.txt": "b\n" });
    const moved = await commitOn(git, "main-next", base, { "z.txt": "z\n" });
    await git.updateRef("main", moved, base);

    const r = await git.rebase(join(dir(), "rb"), "heph/R1", "main");
    expect(r.ok).toBe(true);
    expect(await git.mergeBase("heph/R1", "main")).toBe(moved);
    const wt = join(dir(), "check");
    await git.worktreeAddDetached(wt, "heph/R1");
    expect(existsSync(join(wt, "b.txt")) && existsSync(join(wt, "z.txt"))).toBe(true);
  });

  test("a conflicting rebase reports the files and leaves the branch as it was", async () => {
    const { git } = await withOrigin();
    const base = await git.revParse("main");
    const ours = await commitOn(git, "heph/R1", base, { "a.txt": "ours\n" });
    const theirs = await commitOn(git, "main-next", base, { "a.txt": "theirs\n" });
    await git.updateRef("main", theirs, base);

    const r = await git.rebase(join(dir(), "rb"), "heph/R1", "main");
    expect(r).toEqual({ ok: false, conflicts: ["a.txt"] });
    expect(await git.revParse("heph/R1")).toBe(ours);
  });
});
