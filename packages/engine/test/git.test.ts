import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runOk } from "@hephaestus/sandbox";
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

  const sh = async (cwd: string, ...args: string[]) =>
    (await runOk(["git", "-c", "user.name=T", "-c", "user.email=t@x", ...args], { cwd })).trim();
  const commitFile = async (cwd: string, file: string, content: string, msg: string) => {
    writeFiles(cwd, { [file]: content });
    await sh(cwd, "add", "-A");
    await sh(cwd, "commit", "-q", "-m", msg);
    return sh(cwd, "rev-parse", "HEAD");
  };

  test("rebase_onto_with_upstream_skips_old_base", async () => {
    const { git, repo, wt } = await setup();
    await sh(repo, "checkout", "-q", "-b", "parent");
    const p = await commitFile(repo, "p.txt", "p\n", "P");
    await sh(repo, "checkout", "-q", "-b", "child");
    await commitFile(repo, "c.txt", "c\n", "C");
    await sh(repo, "checkout", "-q", "parent");
    await sh(repo, "reset", "-q", "--hard", "main");
    const p2 = await commitFile(repo, "p.txt", "p\n", "P squashed");
    await sh(repo, "checkout", "-q", "main");
    const r = await git.rebase(wt, "child", p2, p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await sh(repo, "rev-list", "--count", `${p2}..${r.sha}`)).toBe("1");
    expect(await sh(repo, "log", "-1", "--format=%s", r.sha)).toBe("C");
    expect(await git.revParse("child")).toBe(r.sha);
    expect(await git.isAncestor(p2, "child")).toBe(true);
    expect(await git.isAncestor(p, "child")).toBe(false);
  });

  test("rebase_onto_conflict_leaves_branch_untouched", async () => {
    const { git, repo, wt } = await setup();
    await sh(repo, "checkout", "-q", "-b", "child");
    const before = await commitFile(repo, "a.go", "child\n", "C");
    await sh(repo, "checkout", "-q", "main");
    const upstream = await git.revParse("main");
    const onto = await commitFile(repo, "a.go", "main\n", "M");
    const r = await git.rebase(wt, "child", onto, upstream);
    expect(r).toEqual({ ok: false, conflicts: ["a.go"] });
    expect(await git.revParse("child")).toBe(before);
    expect(existsSync(wt)).toBe(false);
  });

  test("cherryPickIn_replays_and_reports_conflict", async () => {
    const { git, repo, wt } = await setup();
    await sh(repo, "checkout", "-q", "-b", "side");
    const clean = await commitFile(repo, "n.txt", "n\n", "N");
    const bad = await commitFile(repo, "a.go", "side\n", "A");
    await sh(repo, "checkout", "-q", "main");
    await commitFile(repo, "a.go", "main\n", "M");
    await git.worktreeAddDetached(wt, "main");
    const ok = await git.cherryPickIn(wt, clean);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.sha).toBe(await sh(wt, "rev-parse", "HEAD"));
      expect(readFileSync(join(wt, "n.txt"), "utf8")).toBe("n\n");
    }
    const head = await sh(wt, "rev-parse", "HEAD");
    expect(await git.cherryPickIn(wt, bad)).toEqual({ ok: false, conflicts: ["a.go"] });
    expect(await sh(wt, "status", "--porcelain")).toBe("");
    expect(await sh(wt, "rev-parse", "HEAD")).toBe(head);
  });

  test("cherryPickIn_replays_empty_commit", async () => {
    const { git, repo, wt } = await setup();
    await sh(repo, "checkout", "-q", "-b", "side");
    await sh(repo, "commit", "-q", "--allow-empty", "-m", "noop\n\nHeph-Run: r-1");
    const empty = await sh(repo, "rev-parse", "HEAD");
    await sh(repo, "checkout", "-q", "main");
    await commitFile(repo, "m.txt", "m\n", "M");
    await git.worktreeAddDetached(wt, "main");
    const r = await git.cherryPickIn(wt, empty);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sha).not.toBe(empty);
    expect(await sh(wt, "log", "-1", "--format=%B", r.sha)).toContain("Heph-Run: r-1");
  });

  test("cherryPickIn_replays_already_applied_change", async () => {
    const { git, repo, wt } = await setup();
    await sh(repo, "checkout", "-q", "-b", "side");
    const c = await commitFile(repo, "n.txt", "n\n", "N\n\nHeph-Run: r-1");
    await sh(repo, "checkout", "-q", "main");
    await commitFile(repo, "n.txt", "n\n", "N again");
    await git.worktreeAddDetached(wt, "main");
    const r = await git.cherryPickIn(wt, c);
    expect(r.ok).toBe(true);
    if (r.ok) expect(await sh(wt, "log", "-1", "--format=%B", r.sha)).toContain("Heph-Run: r-1");
  });

  test("forkPoint_undefined_for_root_commit", async () => {
    const { git, repo } = await setup();
    await sh(repo, "checkout", "-q", "--orphan", "orph");
    await sh(repo, "commit", "-q", "--allow-empty", "-m", "root\n\nHeph-Run: r-9");
    expect(await git.forkPoint("orph", "r-9")).toBeUndefined();
  });

  test("forkPoint_finds_base_after_rebase", async () => {
    const { git, repo, wt } = await setup();
    expect(await git.forkPoint("main", "r-1")).toBeUndefined();
    await sh(repo, "checkout", "-q", "-b", "work");
    await commitFile(repo, "w1.txt", "1\n", "one\n\nHeph-Run: r-10");
    await commitFile(repo, "w2.txt", "2\n", "two\n\nHeph-Run: r-1");
    await commitFile(repo, "w3.txt", "3\n", "three\n\nHeph-Run: r-1");
    expect(await git.forkPoint("work", "r-1")).toBe(await sh(repo, "rev-parse", "work~2"));
    expect(await git.forkPoint("work", "r-2")).toBeUndefined();
    await sh(repo, "checkout", "-q", "main");
    const newBase = await commitFile(repo, "m.txt", "m\n", "M");
    const r = await git.rebase(wt, "work", newBase, "work~2");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await git.forkPoint("work", "r-1")).toBe(newBase);
    expect(await git.forkPoint("work", "r-10")).toBeUndefined();
  });

  test("lsTree_lists_files_at_ref", async () => {
    const { git, repo } = await setup();
    await commitFile(repo, "z.txt", "z\n", "Z");
    expect(await git.lsTree("main")).toEqual(["a.go", "docs/readme.md", "z.txt"]);
    expect(await git.lsTree("main~1")).toEqual(["a.go", "docs/readme.md"]);
  });

  test("fileLines counts the newlines of a file at a ref", async () => {
    const { git, repo } = await setup();
    await commitFile(repo, "three.txt", "a\nb\nc\n", "three");
    expect(await git.fileLines("main", "three.txt")).toBe(3);
    expect(await git.fileLines("main", "a.go")).toBe(1);
  });

  test("fileLines of a submodule (gitlink) entry is 0", async () => {
    const { git, repo } = await setup();
    const head = await git.revParse("main");
    await sh(repo, "update-index", "--add", "--cacheinfo", `160000,${head},vendor/sub`);
    await sh(repo, "commit", "-q", "-m", "submodule");
    expect(await git.lsTree("main")).toContain("vendor/sub");
    expect(await git.fileLines("main", "vendor/sub")).toBe(0);
  });

  test("isAncestor_true_false", async () => {
    const { git, repo } = await setup();
    const base = await git.revParse("main");
    await commitFile(repo, "z.txt", "z\n", "Z");
    expect(await git.isAncestor(base, "main")).toBe(true);
    expect(await git.isAncestor("main", base)).toBe(false);
  });
});
