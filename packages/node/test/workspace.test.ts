import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceConfig } from "@hephaestus/core";
import { describeWorkspace, ensureWorkspace, fetchRunBranches } from "../src/workspace.ts";
import { tempDir } from "./helpers.ts";
import { git, put, repoWithOrigin } from "./repos.ts";

const dir = tempDir();

const WS: WorkspaceConfig = {
  name: "game",
  repos: { proto: "./proto", server: "./server" },
  projects: {
    proto: { repo: "proto", path: ".", stack: "schema" },
    server: { repo: "server", path: ".", stack: "sh" },
  },
};

async function mbp() {
  const root = dir();
  const origins = dir();
  const ws = join(root, "game");
  await repoWithOrigin(join(ws, "proto"), { "messages.txt": "base\n" }, origins);
  await repoWithOrigin(join(ws, "server"), { "README.md": "server\n" }, origins);
  put(join(ws, ".heph", "workspace.yaml"), "name: game\nrepos: {}\n");
  put(join(ws, "server", ".heph", "config.yaml"), "project: { commands: { test: sh t.sh } }\n");
  return { ws, origins };
}

describe("a workspace on another node", () => {
  test("is described with its remotes and uncommitted heph files, and cloned there on demand", async () => {
    const { ws } = await mbp();
    const desc = await describeWorkspace(ws, WS);
    expect(desc.name).toBe("game");
    expect(Object.keys(desc.repos)).toEqual(["proto", "server"]);
    expect(desc.repos.server?.config).toContain("sh t.sh");

    const home = dir();
    const out = await ensureWorkspace(desc, { home, workspaces: {} });
    expect(out).toEqual({ dir: join(home, "workspaces", "game"), cloned: ["proto", "server"] });
    expect(readFileSync(join(out.dir, "server", "README.md"), "utf8")).toBe("server\n");
    expect(readFileSync(join(out.dir, ".heph", "workspace.yaml"), "utf8")).toContain("name: game");
    expect(readFileSync(join(out.dir, "server", ".heph", "config.yaml"), "utf8")).toContain(
      "sh t.sh",
    );
    expect(await ensureWorkspace(desc, { home, workspaces: {} })).toEqual({
      dir: out.dir,
      cloned: [],
    });
  });

  test("uses the node's own path for the name when it has one", async () => {
    const { ws } = await mbp();
    const mine = join(dir(), "code", "game");
    mkdirSync(mine, { recursive: true });
    const out = await ensureWorkspace(await describeWorkspace(ws, WS), {
      home: dir(),
      workspaces: { game: mine },
    });
    expect(out.dir).toBe(mine);
    expect(existsSync(join(mine, "proto", ".git"))).toBe(true);
  });

  test("a single-repo workspace is cloned into the workspace directory itself", async () => {
    const root = dir();
    const repo = join(root, "calc");
    await repoWithOrigin(repo, { "add.sh": "x\n" }, dir());
    put(join(repo, ".heph", "workspace.yaml"), "name: calc\n");
    const one: WorkspaceConfig = {
      name: "calc",
      repos: { calc: "." },
      projects: { calc: { repo: "calc", path: ".", stack: "sh" } },
    };
    const out = await ensureWorkspace(await describeWorkspace(repo, one), {
      home: dir(),
      workspaces: {},
    });
    expect(readFileSync(join(out.dir, "add.sh"), "utf8")).toBe("x\n");
    expect(existsSync(join(out.dir, ".heph", "workspace.yaml"))).toBe(true);
  });

  test("a repo without a remote can't go to another node", async () => {
    const root = dir();
    const repo = join(root, "calc");
    mkdirSync(repo);
    await git(repo, "init", "-q", "-b", "main");
    await expect(
      describeWorkspace(repo, { name: "calc", repos: { calc: "." }, projects: {} }),
    ).rejects.toThrow("needs every repo to have a remote named origin; missing in calc");
  });

  test("a run's branches come from the remotes into the new owner's checkout", async () => {
    const { ws } = await mbp();
    await git(join(ws, "server"), "branch", "heph/R1");
    put(join(ws, "server", "impl.sh"), "echo\n");
    await git(join(ws, "server"), "add", "-A");
    await git(join(ws, "server"), "commit", "-qm", "unit");
    await git(join(ws, "server"), "branch", "-f", "heph/R1", "HEAD");
    await git(join(ws, "server"), "push", "-q", "origin", "heph/R1");

    const other = await ensureWorkspace(await describeWorkspace(ws, WS), {
      home: dir(),
      workspaces: {},
    });
    expect(await fetchRunBranches(other.dir, WS, "R1")).toEqual(["server"]);
    const sha = (cwd: string) => git(cwd, "rev-parse", "heph/R1");
    expect(await sha(join(other.dir, "server"))).toBe(await sha(join(ws, "server")));
  });
});
