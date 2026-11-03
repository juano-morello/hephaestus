import type { Brief } from "../src/schemas/brief.ts";
import type { Plan, Task } from "../src/schemas/plan.ts";
import type { Workspace } from "../src/schemas/workspace.ts";

export function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `task ${id}`,
    kind: "implement",
    project: "server",
    lane: "contained",
    complexity: "standard",
    complexity_reason: "fixture",
    scope: [`${id}/**/*.go`],
    covers: [],
    spec: "fixture",
    ...overrides,
  };
}

export function plan(tasks: Task[], overrides: Partial<Plan> = {}): Plan {
  return { schema: 1, brief_hash: "hash", tasks, risks: [], ...overrides };
}

export function brief(overrides: Partial<Brief> = {}): Brief {
  return {
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
  };
}

/** Gate names configured per project (resolved config). */
export function gates(): Record<string, string[]> {
  return { proto: ["lint", "buf"], server: ["tests", "typecheck", "lint"], client: ["tests"] };
}

export function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    repos: { server: "./server", client: "./client", proto: "./proto" },
    projects: {
      proto: { repo: "proto", path: ".", stack: "schema" },
      server: { repo: "server", path: ".", stack: "go", depends_on: ["proto"] },
      client: { repo: "client", path: ".", stack: "godot", depends_on: ["proto"] },
    },
    ...overrides,
  };
}
