import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { detectWorkspace, initWorkspace } from "../src/init.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heph-init-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function files(dir: string, map: Record<string, string>) {
  for (const [p, c] of Object.entries(map)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
}

function repo(dir: string, map: Record<string, string>) {
  files(dir, map);
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
}

describe("detectWorkspace", () => {
  test("a single Go repo at the workspace root", () => {
    repo(join(root, "game"), { "go.mod": "module game\n" });
    const d = detectWorkspace(join(root, "game"));
    expect(d.repos).toEqual({ game: "." });
    expect(d.projects).toEqual({
      game: {
        repo: "game",
        path: ".",
        stack: "go",
        commands: { test: "go test ./...", typecheck: "go vet ./..." },
      },
    });
  });

  test("several repos under one directory, with stack-specific commands", () => {
    repo(join(root, "server"), { "go.mod": "module s\n" });
    repo(join(root, "web"), {
      "package.json": JSON.stringify({
        scripts: { test: "bun test", typecheck: "tsc --noEmit", lint: "biome ci ." },
      }),
      "bun.lock": "",
    });
    repo(join(root, "proto"), {
      "buf.yaml": "version: v2\n",
      "loot.proto": 'syntax = "proto3";\n',
    });
    mkdirSync(join(root, "not-a-repo"));
    const d = detectWorkspace(root);
    expect(d.repos).toEqual({ proto: "./proto", server: "./server", web: "./web" });
    expect(d.projects.web).toEqual({
      repo: "web",
      path: ".",
      stack: "ts",
      commands: { test: "bun run test", typecheck: "bun run typecheck", lint: "bun run lint" },
    });
    expect(d.projects.proto).toEqual({
      repo: "proto",
      path: ".",
      stack: "schema",
      commands: { lint: "buf lint" },
    });
  });

  test("a monorepo with projects in subdirectories, including a nested Godot root", () => {
    repo(join(root, "mmo"), {
      "server/go.mod": "module s\n",
      "client/godot/project.godot": "[application]\n",
      "README.md": "x",
    });
    const d = detectWorkspace(join(root, "mmo"));
    expect(d.repos).toEqual({ mmo: "." });
    expect(d.projects).toEqual({
      client: { repo: "mmo", path: "client/godot", stack: "godot", commands: {} },
      server: {
        repo: "mmo",
        path: "server",
        stack: "go",
        commands: { test: "go test ./...", typecheck: "go vet ./..." },
      },
    });
  });

  test("no git repository is an error", () => {
    expect(() => detectWorkspace(root)).toThrow("no git repository found in or under");
  });
});

describe("initWorkspace", () => {
  test("writes workspace.yaml and per-repo config that loadConfig accepts", async () => {
    repo(join(root, "server"), { "go.mod": "module s\n" });
    repo(join(root, "web"), { "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
    const out = initWorkspace(root);
    expect(out.written.sort()).toEqual([
      join(root, ".heph", "workspace.yaml"),
      join(root, "server", ".heph", "config.yaml"),
      join(root, "web", ".heph", "config.yaml"),
    ]);
    const { config, sources } = await loadConfig({
      workspaceDir: root,
      home: join(root, "home"),
      nodeId: "n",
    });
    expect(Object.keys(config.workspace.repos).sort()).toEqual(["server", "web"]);
    expect(config.projects.server?.commands).toEqual({
      test: "go test ./...",
      typecheck: "go vet ./...",
    });
    expect(config.projects.web?.commands).toEqual({ test: "npm run test" });
    expect(sources["projects.server.commands.test"]).toContain(
      join("server", ".heph", "config.yaml"),
    );
  });

  test("never overwrites without force", () => {
    repo(join(root, "server"), { "go.mod": "module s\n" });
    initWorkspace(root);
    writeFileSync(join(root, ".heph", "workspace.yaml"), "# mine\n");
    expect(() => initWorkspace(root)).toThrow("already exists (use --force to overwrite)");
    expect(readFileSync(join(root, ".heph", "workspace.yaml"), "utf8")).toBe("# mine\n");
    initWorkspace(root, { force: true });
    expect(readFileSync(join(root, ".heph", "workspace.yaml"), "utf8")).toContain("repos:");
    expect(existsSync(join(root, "server", ".heph", "config.yaml"))).toBe(true);
  });
});
