import { z } from "zod";
import { Workspace } from "./workspace.ts";

/** SPEC section 5: layered configuration. Each layer file has its own schema; the merge is `ResolvedConfig`. */

export const Route = z
  .object({ model: z.string().min(1), effort: z.string().min(1).optional() })
  .strict();
export type Route = z.infer<typeof Route>;

/** Complexity tiers plus `default`, which covers missing tiers (SPEC section 10). */
export const RoleRoutes = z
  .object({
    trivial: Route.optional(),
    standard: Route.optional(),
    complex: Route.optional(),
    default: Route.optional(),
  })
  .strict();
export type RoleRoutes = z.infer<typeof RoleRoutes>;

export const Routing = z.record(z.string().min(1), RoleRoutes);
export type Routing = z.infer<typeof Routing>;

export const Limits = z
  .object({
    attempts_per_unit: z.int().positive(),
    budget_tokens: z.int().positive(),
    gate_timeout_ms: z.int().positive(),
  })
  .strict();
export type Limits = z.infer<typeof Limits>;

export const SandboxConfig = z
  .object({
    mode: z.enum(["container", "native"]),
    runtime: z.enum(["docker", "podman"]),
    image: z.string().min(1),
    integration_image: z.string().min(1).optional(),
  })
  .strict();
export type SandboxConfig = z.infer<typeof SandboxConfig>;

export const NodeConfig = z.object({ id: z.string().min(1) }).strict();
export type NodeConfig = z.infer<typeof NodeConfig>;

/** Another node this one talks to (SPEC section 7), reached over SSH. */
export const PeerNode = z
  .object({
    /** An ssh destination: a host from ~/.ssh/config, or user@host. */
    ssh: z.string().min(1),
    /** The heph binary on that node. Default "heph". */
    heph: z.string().min(1).optional(),
    /** Its HEPH_HOME. Default: its own default (~/.heph). */
    home: z.string().min(1).optional(),
    labels: z.array(z.string().min(1)).optional(),
    /** New runs go to the preferred node when it is reachable. */
    preferred: z.boolean().optional(),
  })
  .strict();
export type PeerNode = z.infer<typeof PeerNode>;

export const SyncConfig = z.object({ interval_s: z.int().positive() }).strict();
export type SyncConfig = z.infer<typeof SyncConfig>;

const WorkspaceName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "letters, digits, dot, dash and underscore");

export const ProjectCommands = z
  .object({
    test: z.string().min(1).optional(),
    typecheck: z.string().min(1).optional(),
    lint: z.string().min(1).optional(),
  })
  .strict();
export type ProjectCommands = z.infer<typeof ProjectCommands>;

/** Per project settings, owned by the project's repo (`<repo>/.heph/config.yaml`). */
export const ProjectSettings = z
  .object({
    commands: ProjectCommands,
    image: z.string().min(1).optional(),
    gates: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ProjectSettings = z.infer<typeof ProjectSettings>;

/** `<workspace>/.heph/workspace.yaml`: the Workspace plus the branch each repo lands on. */
export const WorkspaceConfig = Workspace.safeExtend({
  /** Names the workspace across nodes; each node maps it to a path (`workspaces`). */
  name: WorkspaceName.optional(),
  targets: z.record(z.string(), z.string().min(1)).optional(),
}).superRefine((ws, ctx) => {
  for (const repo of Object.keys(ws.targets ?? {})) {
    if (!(repo in ws.repos)) {
      ctx.addIssue({ code: "custom", path: ["targets", repo], message: `unknown repo "${repo}"` });
    }
  }
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfig>;

export const ResolvedConfig = z
  .object({
    node: NodeConfig,
    routing: Routing,
    limits: Limits,
    sandbox: SandboxConfig,
    workspace: WorkspaceConfig,
    projects: z.record(z.string(), ProjectSettings),
    nodes: z.record(z.string(), PeerNode),
    /** Workspace name -> its checkout on this node. */
    workspaces: z.record(WorkspaceName, z.string().min(1)),
    sync: SyncConfig,
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const name of Object.keys(config.projects)) {
      if (!(name in config.workspace.projects)) {
        ctx.addIssue({
          code: "custom",
          path: ["projects", name],
          message: `unknown project "${name}"`,
        });
      }
    }
  });
export type ResolvedConfig = z.infer<typeof ResolvedConfig>;

/** `~/.heph/config.yaml` (or `$HEPH_HOME/config.yaml`): node-wide settings. */
export const HomeConfigLayer = z
  .object({
    node: NodeConfig.partial().optional(),
    routing: Routing.optional(),
    limits: Limits.partial().optional(),
    sandbox: SandboxConfig.partial().optional(),
    nodes: z.record(z.string(), PeerNode).optional(),
    workspaces: z.record(WorkspaceName, z.string().min(1)).optional(),
    sync: SyncConfig.partial().optional(),
  })
  .strict();
export type HomeConfigLayer = z.infer<typeof HomeConfigLayer>;

export const ProjectLayer = z
  .object({
    commands: ProjectCommands.optional(),
    image: z.string().min(1).optional(),
    gates: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ProjectLayer = z.infer<typeof ProjectLayer>;

/** `<repo>/.heph/config.yaml`: `projects.<name>`, or `project` when the repo has one project. */
export const RepoConfigLayer = z
  .object({
    project: ProjectLayer.optional(),
    projects: z.record(z.string(), ProjectLayer).optional(),
  })
  .strict()
  .refine((layer) => !(layer.project && layer.projects), {
    message: "use either project or projects, not both",
    path: ["project"],
  });
export type RepoConfigLayer = z.infer<typeof RepoConfigLayer>;

export type DefaultConfig = Omit<ResolvedConfig, "workspace" | "projects">;

/** Built-in defaults: everything except the workspace, which comes from workspace.yaml or is implied. */
export function defaultConfig(opts: { nodeId: string }): DefaultConfig {
  // Exact model ids: OMP matches a bare "opus" or "sonnet" to an older model in its catalog.
  const tiered = (): RoleRoutes => ({
    trivial: { model: "claude/claude-haiku-5-5" },
    standard: { model: "claude/claude-sonnet-5-5", effort: "medium" },
    complex: { model: "claude/claude-sonnet-5-5", effort: "high" },
  });
  return {
    node: { id: opts.nodeId },
    routing: {
      planner: { default: { model: "claude/claude-opus-5-5", effort: "high" } },
      test_author: tiered(),
      implementer: tiered(),
      documenter: { default: { model: "claude/claude-haiku-5-5" } },
    },
    limits: { attempts_per_unit: 3, budget_tokens: 20000, gate_timeout_ms: 600000 },
    sandbox: { mode: "container", runtime: "docker", image: "alpine:3.20" },
    nodes: {},
    workspaces: {},
    sync: { interval_s: 30 },
  };
}
