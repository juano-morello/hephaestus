import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRoleFiles, ROLE_FILE_LIMIT, roleInstructions } from "../src/role-files.ts";

let root: string;
let home: string;
let repo: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "heph-roles-"));
  home = join(root, "home");
  repo = join(root, "repo");
  await mkdir(join(home, "roles"), { recursive: true });
  await mkdir(join(repo, ".heph", "roles"), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const homeFile = (role: string, text: string) => writeFile(join(home, "roles", `${role}.md`), text);
const repoFile = (role: string, text: string) =>
  writeFile(join(repo, ".heph", "roles", `${role}.md`), text);
const ask = (role = "implementer") => roleInstructions({ home, dir: repo, dirLayer: "repo", role });

describe("roleInstructions", () => {
  test("home text then repo text, joined by a blank line", async () => {
    await homeFile("implementer", "home text\n");
    await repoFile("implementer", "repo text\n");
    expect(ask()).toBe("home text\n\nrepo text");
  });

  test("only one layer present gives that text", async () => {
    await repoFile("implementer", "repo text");
    expect(ask()).toBe("repo text");
    await rm(join(repo, ".heph", "roles", "implementer.md"));
    await homeFile("implementer", "home text");
    expect(ask()).toBe("home text");
  });

  test("empty or whitespace-only files add nothing", async () => {
    await homeFile("implementer", "  \n\n");
    await repoFile("implementer", "");
    expect(ask()).toBeUndefined();
  });

  test("no files gives undefined", () => {
    expect(ask()).toBeUndefined();
  });

  test("a directory in place of the file is an error naming the path", async () => {
    await mkdir(join(repo, ".heph", "roles", "implementer.md"));
    expect(() => ask()).toThrow("can't read role file");
    expect(() => ask()).toThrow(join(repo, ".heph", "roles", "implementer.md"));
  });

  test("a file over 16 KB is an error", async () => {
    await repoFile("implementer", "x".repeat(ROLE_FILE_LIMIT + 1));
    expect(() => ask()).toThrow("is over 16 KB");
  });

  test("a file of exactly 16 KB is accepted", async () => {
    await repoFile("implementer", "x".repeat(ROLE_FILE_LIMIT));
    expect(ask()?.length).toBe(ROLE_FILE_LIMIT);
  });
});

describe("listRoleFiles", () => {
  test("lists existing files with role, path and layer", async () => {
    await homeFile("planner", "p");
    await homeFile("implementer", "i");
    await repoFile("test_author", "t");
    await mkdir(join(root, "ws", ".heph", "roles"), { recursive: true });
    await writeFile(join(root, "ws", ".heph", "roles", "planner.md"), "wp");
    const list = listRoleFiles({ home, workspaceDir: join(root, "ws"), repoDirs: [repo] });
    expect(list).toContainEqual({
      role: "planner",
      path: join(home, "roles", "planner.md"),
      layer: "home",
    });
    expect(list).toContainEqual({
      role: "implementer",
      path: join(home, "roles", "implementer.md"),
      layer: "home",
    });
    expect(list).toContainEqual({
      role: "test_author",
      path: join(repo, ".heph", "roles", "test_author.md"),
      layer: "repo",
    });
    expect(list).toContainEqual({
      role: "planner",
      path: join(root, "ws", ".heph", "roles", "planner.md"),
      layer: "workspace",
    });
    expect(list).toHaveLength(4);
  });

  test("a repo that is the workspace directory is listed once", async () => {
    await repoFile("planner", "p");
    await repoFile("implementer", "i");
    const list = listRoleFiles({ home, workspaceDir: repo, repoDirs: [repo] });
    const paths = list.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(list).toHaveLength(2);
  });

  test("empty files are not listed; none gives []", async () => {
    expect(listRoleFiles({ home, workspaceDir: repo, repoDirs: [repo] })).toEqual([]);
    await repoFile("implementer", " \n");
    expect(listRoleFiles({ home, workspaceDir: repo, repoDirs: [repo] })).toEqual([]);
  });

  test("an unreadable or oversized file is an error", async () => {
    await repoFile("documenter", "x".repeat(ROLE_FILE_LIMIT + 1));
    expect(() => listRoleFiles({ home, workspaceDir: repo, repoDirs: [repo] })).toThrow(
      "is over 16 KB",
    );
  });
});
