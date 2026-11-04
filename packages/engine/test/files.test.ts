import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "@hephaestus/core";
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
});
