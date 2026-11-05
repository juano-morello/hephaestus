import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "@hephaestus/core";
import { runOk } from "@hephaestus/sandbox";
import { projectFiles } from "../src/files.ts";
import { initRepo, tempDir } from "./helpers.ts";

const dir = tempDir();

describe("projectFiles", () => {
  test("lists each project's tracked files, project-relative, across repos and nested roots", async () => {
    const root = dir();
    mkdirSync(join(root, "mono"));
    mkdirSync(join(root, "proto"));
    await initRepo(join(root, "mono"), { "go.mod": "m", "cmd/main.go": "x", "pkg/a/x.go": "x" });
    await initRepo(join(root, "proto"), { "messages.proto": "x" });
    const ws: Workspace = {
      repos: { mono: "./mono", proto: "./proto" },
      projects: {
        app: { repo: "mono", path: ".", stack: "go" },
        lib: { repo: "mono", path: "pkg/a", stack: "go" },
        proto: { repo: "proto", path: ".", stack: "schema" },
      },
    };
    expect(await projectFiles(ws, root)).toEqual({
      app: ["cmd/main.go", "go.mod", "pkg/a/x.go"],
      lib: ["x.go"],
      proto: ["messages.proto"],
    });
  });

  test("with refs, lists the ref's files and ignores the working tree", async () => {
    const root = dir();
    mkdirSync(join(root, "mono"));
    await initRepo(join(root, "mono"), { "a.go": "x", "pkg/b.go": "x" });
    writeFileSync(join(root, "mono", "extra.go"), "x");
    await runOk(["git", "add", "-A"], { cwd: join(root, "mono") });
    await runOk(["git", "rm", "-q", "-f", "a.go"], { cwd: join(root, "mono") });
    const ws: Workspace = {
      repos: { mono: "./mono" },
      projects: { app: { repo: "mono", path: ".", stack: "go" } },
    };
    expect(await projectFiles(ws, root)).toEqual({ app: ["extra.go", "pkg/b.go"] });
    expect(await projectFiles(ws, root, { mono: "main" })).toEqual({ app: ["a.go", "pkg/b.go"] });
  });
});
