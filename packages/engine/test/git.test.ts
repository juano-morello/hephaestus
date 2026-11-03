import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createGit } from "../src/git.ts";
import { initRepo, tempDir, writeFiles } from "./helpers.ts";

const dir = tempDir();

async function setup() {
  const repo = await initRepo(dir(), { "a.go": "package a\n", "docs/readme.md": "hi\n" });
  return { repo, git: createGit(repo), wt: join(dir(), "wt") };
}

describe("git", () => {
  test("creates and force-resets a branch at a ref", async () => {
    const { git } = await setup();
    const base = await git.revParse("main");
    await git.branchForce("heph/R1", base);
    expect(await git.revParse("heph/R1")).toBe(base);
    await git.branchForce("heph/R1", base);
    expect(await git.revParse("heph/R1")).toBe(base);
  });

  test("an attempt worktree: write, commit, diff against the tip, remove", async () => {
    const { git, wt } = await setup();
    const tip = await git.revParse("main");
    await git.worktreeAdd(wt, "heph-attempt/R1/T1/a1", tip);
    expect(readFileSync(join(wt, "a.go"), "utf8")).toBe("package a\n");
    writeFiles(wt, { "a.go": "package a\n\nfunc A() {}\n", "a_test.go": "package a\n" });
    const sha = await git.commitAll(wt, "heph: R1 T1 a1");
    expect(await git.revParse("heph-attempt/R1/T1/a1")).toBe(sha);
    const diff = await git.diff(tip, sha);
    expect(diff.files).toEqual(["a.go", "a_test.go"]);
    expect(diff.text).toContain("+func A() {}");
    await git.worktreeRemove(wt);
    expect(existsSync(wt)).toBe(false);
  });

  test("an attempt with no changes still gets a commit and an empty diff", async () => {
    const { git, wt } = await setup();
    const tip = await git.revParse("main");
    await git.worktreeAdd(wt, "heph-attempt/R1/T1/a1", tip);
    const sha = await git.commitAll(wt, "heph: nothing");
    expect(sha).not.toBe(tip);
    expect(await git.diff(tip, sha)).toEqual({ files: [], text: "" });
  });

  test("re-adding a worktree for an existing attempt branch resets it to the given ref", async () => {
    const { git, wt } = await setup();
    const tip = await git.revParse("main");
    await git.worktreeAdd(wt, "heph-attempt/R1/T1/a1", tip);
    writeFiles(wt, { "x.go": "x" });
    await git.commitAll(wt, "first try");
    await git.worktreeRemove(wt);
    await git.worktreeAdd(wt, "heph-attempt/R1/T1/a1", tip);
    expect(await git.revParse("heph-attempt/R1/T1/a1")).toBe(tip);
    expect(existsSync(join(wt, "x.go"))).toBe(false);
  });

  test("update-ref moves a branch only from the expected value", async () => {
    const { git, wt } = await setup();
    const base = await git.revParse("main");
    await git.branchForce("heph/R1", base);
    await git.worktreeAdd(wt, "heph-attempt/R1/T1/a1", base);
    writeFiles(wt, { "b.go": "b" });
    const sha = await git.commitAll(wt, "b");
    await expect(git.updateRef("heph/R1", sha, sha)).rejects.toThrow();
    await git.updateRef("heph/R1", sha, base);
    expect(await git.revParse("heph/R1")).toBe(sha);
  });

  test("lists tracked files in a worktree", async () => {
    const { git, repo } = await setup();
    expect(await git.lsFiles(repo)).toEqual(["a.go", "docs/readme.md"]);
  });
});
