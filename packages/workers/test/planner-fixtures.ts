import type { Brief, ProjectGates, Workspace } from "@hephaestus/core";

export const brief = (overrides: Partial<Brief> = {}): Brief => ({
  schema: 1,
  goal: "items stack up to a per-type cap",
  context: "",
  decisions: [],
  constraints: [],
  acceptance: [{ id: "AC1", text: "stacks cap at max", kind: "behavior" }],
  out_of_scope: [],
  open_questions: [],
  source: "cli",
  ...overrides,
});

export const workspace = (): Workspace => ({
  repos: { server: "./server", client: "./client", proto: "./proto" },
  projects: {
    proto: { repo: "proto", path: ".", stack: "schema" },
    server: { repo: "server", path: ".", stack: "go", depends_on: ["proto"] },
    client: { repo: "client", path: ".", stack: "godot", depends_on: ["proto"] },
  },
});

export const gates = (): ProjectGates => ({
  proto: ["lint", "buf"],
  server: ["tests", "typecheck", "lint"],
  client: ["tests"],
});
