import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Brief, briefHash, type Plan, type Task, type Workspace } from "@hephaestus/core";
import type { EngineConfig } from "../src/config.ts";
import type { Worker } from "../src/worker.ts";
import { initRepo, writeFiles } from "./helpers.ts";

/** Three separate git repos under one workspace root: proto and server are touched, web is not. */
export async function threeRepos(root: string, extra: Partial<Workspace> = {}) {
  const fixtures: Record<string, Record<string, string>> = {
    proto: { "messages.txt": "base\n" },
    server: { "README.md": "server\n" },
    web: { "index.html": "web\n" },
  };
  for (const [name, files] of Object.entries(fixtures)) {
    mkdirSync(join(root, name));
    await initRepo(join(root, name), files);
  }
  const workspace: Workspace = {
    repos: { proto: "./proto", server: "./server", web: "./web" },
    projects: {
      proto: { repo: "proto", path: ".", stack: "schema" },
      server: { repo: "server", path: ".", stack: "sh", depends_on: ["proto"] },
      web: { repo: "web", path: ".", stack: "ts" },
    },
    ...extra,
  };
  return { root, workspace };
}

export const brief: Brief = {
  schema: 1,
  goal: "loot drops reach the server",
  context: "",
  decisions: [],
  constraints: [],
  acceptance: [{ id: "AC1", text: "server handles LootDrop", kind: "behavior" }],
  out_of_scope: [],
  open_questions: [],
  source: "cli",
};

const task = (id: string, t: Partial<Task>): Task => ({
  id,
  title: id,
  kind: "implement",
  project: "server",
  lane: "contained",
  complexity: "standard",
  complexity_reason: "x",
  scope: [],
  covers: ["AC1"],
  spec: id,
  ...t,
});

export const crossRepoPlan = (lane: Task["lane"] = "contained"): Plan => ({
  schema: 1,
  brief_hash: briefHash(brief),
  tasks: [
    task("P1", {
      project: "proto",
      kind: "codegen",
      covers: [],
      scope: ["loot.txt"],
      produces: ["proto:Loot"],
      lane,
    }),
    task("S1", {
      kind: "test",
      scope: ["check.sh"],
      consumes: ["proto:Loot"],
      produces: ["test:Loot"],
    }),
    task("S2", { scope: ["impl.sh"], consumes: ["test:Loot"] }),
  ],
  risks: [],
});

export const crossRepoFiles = {
  P1: { "loot.txt": "LootDrop\n" },
  S1: { "check.sh": "test -f impl.sh\n" },
  S2: { "impl.sh": "echo loot\n" },
};

export const config: EngineConfig = {
  routing: {
    test_author: { default: { model: "claude/sonnet" } },
    implementer: { default: { model: "claude/sonnet" } },
  },
  maxAttempts: 3,
  budgetTokens: 20_000,
  tools: [],
  commands: {},
};

export function writeScript(root: string, path: string, body: string) {
  writeFiles(root, { [path]: body });
}

/** Writes each unit's files from crossRepoFiles and reports them as touched. */
export const writer: Worker = {
  async spawn(input) {
    const files = crossRepoFiles[input.brief.task.id as keyof typeof crossRepoFiles] ?? {};
    writeFiles(input.workdir, files);
    return {
      output: { schema: 1, summary: "", claims: [], touched: Object.keys(files) },
      transcript: "",
      usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      exit: "ok",
    };
  },
};
