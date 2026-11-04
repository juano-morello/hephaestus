import type { ProcResult } from "./proc.ts";

export type ExecOptions = {
  /** Relative to the sandbox root, or absolute inside it. */
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string;
};

/**
 * Where a worker's file and shell operations happen (SPEC section 12). Paths are relative to
 * the project root or absolute inside `root`; anything else is refused.
 */
export interface Sandbox {
  readonly kind: "container" | "native";
  /** "/work" in a container, the project's host dir in native mode. */
  readonly root: string;
  exec(command: string, opts?: ExecOptions): Promise<ProcResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  dispose(): Promise<void>;
}

export type ContainerSpec = {
  mode: "container";
  /** The project root inside the attempt's worktree; mounted read-write at /work. */
  hostDir: string;
  image: string;
  runtime?: "docker" | "podman";
  cpus?: number;
  memory?: string;
};

/**
 * On the host (SPEC section 12, native mode): file paths are confined by the tools, and commands
 * run under sandbox-exec (macOS) or bwrap (Linux): writes only in the project and temp, no
 * network, and `denyRead` (credentials in the home directory by default) unreadable.
 */
export type NativeSpec = { mode: "native"; hostDir: string; denyRead?: string[] };

export type SandboxSpec = ContainerSpec | NativeSpec;

export async function openSandbox(spec: SandboxSpec): Promise<Sandbox> {
  if (spec.mode === "native") return (await import("./native.ts")).openNative(spec);
  return (await import("./docker.ts")).openContainer(spec);
}
