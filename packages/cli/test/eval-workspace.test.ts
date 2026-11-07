import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EvalTask, Workspace } from "@hephaestus/core";
import { prepareEvalWorkspace } from "../src/eval/workspace.ts";

let root: string;
let suite: string;
let real: string;
let origin: string;
let first: string;
let second: string;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@x", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heph-evws-"));
  suite = join(root, "suite");
  real = join(root, "calc");
  origin = join(root, "calc.git");
  mkdirSync(suite, { recursive: true });
  put(join(real, "README.md"), "one\n");
  git(real, "init", "-q", "-b", "main");
  git(real, "add", "-A");
  git(real, "commit", "-qm", "first");
  first = git(real, "rev-parse", "HEAD");
  put(join(real, "README.md"), "two\n");
  git(real, "commit", "-qam", "second");
  second = git(real, "rev-parse", "HEAD");
  git(root, "clone", "-q", "--bare", real, origin);
  git(real, "remote", "add", "origin", origin);
  // An uncommitted repo config, as a developer's checkout has.
  put(join(real, ".heph", "config.yaml"), "projects:\n  calc:\n    commands: { test: real }\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const workspace: Workspace = {
  repos: { calc: "../calc" },
  projects: { calc: { repo: "calc", path: ".", stack: "sh" } },
};
const task = (ref: Record<string, string> = { calc: first }): EvalTask => ({
  id: "add-task",
  workspace_ref: ref,
  brief: "../briefs/b.yaml",
  expect: "escalate",
  tags: [],
});
const prepare = (t = task(), ws = workspace) =>
  prepareEvalWorkspace({ suiteDir: suite, workspace: ws, task: t, dir: join(root, "run") });

const snapshot = () => ({
  head: git(real, "rev-parse", "HEAD"),
  refs: git(real, "for-each-ref"),
  status: git(real, "status", "--porcelain"),
  remotes: git(real, "remote"),
  config: readFileSync(join(real, ".git", "config"), "utf8"),
});

describe("prepareEvalWorkspace", () => {
  test("the clone is at the pin, has no remote, and an eval-base branch", async () => {
    const r = await prepare();
    const clone = join(root, "run", "calc");
    expect(r.workspaceDir).toBe(join(root, "run"));
    expect(r.repoDirs).toEqual({ calc: clone });
    expect(r.base).toEqual({ calc: first });
    expect(git(clone, "rev-parse", "HEAD")).toBe(first);
    expect(git(clone, "remote")).toBe("");
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("eval-base");
    expect(git(clone, "rev-parse", "eval-base")).toBe(first);
    expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("one\n");
    // The later commit is in the history (a clone has everything), but nothing points at it
    // from a remote, and the working tree is the pin.
    expect(git(clone, "branch", "-r")).toBe("");
  });

  test("the real repo's refs, HEAD, remotes and working tree are unchanged", async () => {
    const before = snapshot();
    await prepare();
    expect(snapshot()).toEqual(before);
    expect(before.remotes).toBe("origin");
    expect(git(real, "rev-parse", "HEAD")).toBe(second);
  });

  test("the clone does not share objects with the real repo", async () => {
    await prepare();
    expect(existsSync(join(root, "run", "calc", ".git", "objects", "info", "alternates"))).toBe(
      false,
    );
  });

  test("workspace.yaml has local repo paths, the eval name and the targets", async () => {
    await prepare();
    const ws = Bun.YAML.parse(
      readFileSync(join(root, "run", ".heph", "workspace.yaml"), "utf8"),
    ) as Record<string, unknown>;
    expect(ws).toMatchObject({
      name: "eval-add-task",
      repos: { calc: "./calc" },
      projects: { calc: { repo: "calc", path: ".", stack: "sh" } },
      targets: { calc: "eval-base" },
    });
  });

  test("the repo config comes from the suite's repo-configs when present", async () => {
    put(
      join(suite, "repo-configs", "calc.yaml"),
      "projects:\n  calc:\n    commands: { test: suite }\n",
    );
    await prepare();
    expect(readFileSync(join(root, "run", "calc", ".heph", "config.yaml"), "utf8")).toContain(
      "test: suite",
    );
  });

  test("otherwise it is copied from the real repo's working copy", async () => {
    await prepare();
    expect(readFileSync(join(root, "run", "calc", ".heph", "config.yaml"), "utf8")).toContain(
      "test: real",
    );
  });

  test("a repo with neither gets no config", async () => {
    rmSync(join(real, ".heph"), { recursive: true });
    await prepare();
    expect(existsSync(join(root, "run", "calc", ".heph", "config.yaml"))).toBe(false);
  });

  test("two repos are each cloned and pinned", async () => {
    const other = join(root, "other");
    put(join(other, "f.txt"), "x\n");
    git(other, "init", "-q", "-b", "main");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "o1");
    const pin = git(other, "rev-parse", "HEAD");
    const ws: Workspace = {
      repos: { calc: "../calc", other: "../other" },
      projects: {
        calc: { repo: "calc", path: ".", stack: "sh" },
        other: { repo: "other", path: ".", stack: "sh" },
      },
    };
    const r = await prepare(task({ calc: first, other: pin }), ws);
    expect(r.base).toEqual({ calc: first, other: pin });
    expect(Object.keys(r.repoDirs).sort()).toEqual(["calc", "other"]);
    const written = Bun.YAML.parse(
      readFileSync(join(root, "run", ".heph", "workspace.yaml"), "utf8"),
    ) as { repos: Record<string, string>; targets: Record<string, string> };
    expect(written.repos).toEqual({ calc: "./calc", other: "./other" });
    expect(written.targets).toEqual({ calc: "eval-base", other: "eval-base" });
  });

  test("an unpinnable commit is an error", async () => {
    await expect(prepare(task({ calc: "deadbeefdeadbeef" }))).rejects.toThrow();
  });
});
