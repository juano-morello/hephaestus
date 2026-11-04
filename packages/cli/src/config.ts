import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  defaultConfig,
  HomeConfigLayer,
  type ProjectLayer,
  RepoConfigLayer,
  ResolvedConfig,
  WorkspaceConfig,
} from "@hephaestus/core";
import type { z } from "zod";

/** Where a resolved value came from: a file path, "default" or "flag". */
export type Sources = Record<string, string>;
export type LoadedConfig = { config: ResolvedConfig; sources: Sources };

export type LoadOptions = {
  workspaceDir: string;
  /** The node's home: `$HEPH_HOME`, else `~/.heph`. Its `config.yaml` is the node layer. */
  home: string;
  /** Dotted keys from flags or env, applied last: `{ "limits.attempts_per_unit": 5 }`. */
  overrides?: Record<string, unknown>;
  /** Default node id; the host name when omitted. */
  nodeId?: string;
};

export type ConfigIssue = { file: string; line?: number; key: string; message: string };

export class ConfigError extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super(issues.map(formatIssue).join("\n"));
    this.name = "ConfigError";
  }
}

function formatIssue(i: ConfigIssue): string {
  const where = i.line ? `${i.file}:${i.line}` : i.file;
  return i.key ? `${where}: ${i.key}: ${i.message}` : `${where}: ${i.message}`;
}

type Obj = Record<string, unknown>;
type Path = (string | number)[];

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** A route (`routing.<role>.<tier>`) is one value: a later layer replaces it whole. */
const isAtomic = (path: string[]) => path.length === 3 && path[0] === "routing";

/** Later wins, leaf by leaf. Arrays and routes replace; `sources` follows every leaf. */
function apply(target: Obj, layer: Obj, source: string, sources: Sources, prefix: string[] = []) {
  for (const [k, v] of Object.entries(layer)) {
    if (v === undefined) continue;
    const path = [...prefix, k];
    if (isObj(v) && !isAtomic(path)) {
      if (!isObj(target[k])) {
        forget(sources, path);
        target[k] = {};
      }
      apply(target[k] as Obj, v, source, sources, path);
    } else {
      forget(sources, path);
      target[k] = structuredClone(v);
      record(sources, path, v, source);
    }
  }
}

function forget(sources: Sources, path: string[]) {
  const key = path.join(".");
  for (const k of Object.keys(sources)) {
    if (k === key || k.startsWith(`${key}.`)) delete sources[k];
  }
}

function record(sources: Sources, path: string[], value: unknown, source: string) {
  if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) record(sources, [...path, k], v, source);
  } else if (value !== undefined) {
    sources[path.join(".")] = source;
  }
}

/** Dotted leaf keys of a value, in order. Arrays are leaves. */
function leaves(value: unknown, prefix: string[] = []): [string, unknown][] {
  if (!isObj(value)) return value === undefined ? [] : [[prefix.join("."), value]];
  return Object.entries(value).flatMap(([k, v]) => leaves(v, [...prefix, k]));
}

function expand(dotted: Record<string, unknown>): Obj {
  const out: Obj = {};
  for (const [key, value] of Object.entries(dotted)) {
    const parts = key.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) {
      if (!isObj(node[part])) node[part] = {};
      node = node[part] as Obj;
    }
    node[parts[parts.length - 1] as string] = value;
  }
  return out;
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string) => line.trim() === "" || line.trimStart().startsWith("#");
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const keyAt = (text: string, key: string) =>
  new RegExp(`^(["']?)${escapeRegex(key)}\\1\\s*:(\\s|$)`).test(text);

/**
 * Best-effort 1-based line of a key path in YAML text (Bun.YAML has no positions). Follows block
 * mappings and sequences; inside a flow collection it stops at the line that opens it.
 */
export function findLine(text: string, path: Path): number | undefined {
  const lines = text.split("\n");
  let at = -1;
  let parentIndent = -1;
  for (const seg of path) {
    const parent = at >= 0 ? (lines[at] as string) : "";
    if (typeof seg === "string" && at >= 0) {
      const item = parent.trimStart();
      if (item.startsWith("- ") && keyAt(item.slice(2).trimStart(), seg)) continue;
    }
    let childIndent: number | undefined;
    let count = 0;
    let hit = -1;
    for (let i = at + 1; i < lines.length; i++) {
      const line = lines[i] as string;
      if (isBlank(line)) continue;
      const indent = indentOf(line);
      if (indent <= parentIndent) break;
      childIndent ??= indent;
      if (indent !== childIndent) continue;
      const content = line.trimStart();
      if (typeof seg === "number") {
        if (content.startsWith("-") && count++ === seg) {
          hit = i;
          break;
        }
      } else if (keyAt(content, seg)) {
        hit = i;
        break;
      }
    }
    if (hit < 0) return at >= 0 ? at + 1 : undefined;
    at = hit;
    parentIndent = indentOf(lines[hit] as string);
  }
  return at >= 0 ? at + 1 : undefined;
}

function issuesOf(error: z.ZodError, file: string, text: string, mount: string[] = []) {
  return error.issues.map((issue): ConfigIssue => {
    const path: Path = [...issue.path].map((p) => (typeof p === "symbol" ? String(p) : p));
    if (issue.code === "unrecognized_keys" && issue.keys[0]) path.push(issue.keys[0]);
    const line = findLine(text, path);
    return {
      file,
      ...(line ? { line } : {}),
      key: [...mount, ...path].join("."),
      message: issue.message,
    };
  });
}

type FileLayer<T> = { file: string; text: string; data: T };

async function readLayer<S extends z.ZodType>(
  file: string,
  schema: S,
  mount: string[] = [],
): Promise<FileLayer<z.infer<S>> | undefined> {
  if (!existsSync(file)) return undefined;
  const text = await readFile(file, "utf8");
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text) ?? {};
  } catch (e) {
    const line = (e as { line?: unknown }).line;
    throw new ConfigError([
      {
        file,
        ...(typeof line === "number" && line > 0 ? { line } : {}),
        key: "",
        message: (e as Error).message,
      },
    ]);
  }
  if (!isObj(raw)) throw new ConfigError([{ file, key: "", message: "expected a mapping" }]);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(issuesOf(parsed.error, file, text, mount));
  return { file, text, data: parsed.data };
}

function impliedWorkspace(workspaceDir: string): WorkspaceConfig {
  const name = basename(resolve(workspaceDir)) || "workspace";
  return {
    repos: { [name]: "." },
    projects: { [name]: { repo: name, path: ".", stack: "unknown" } },
  };
}

/** SPEC section 5: defaults, then home, workspace, each repo, then overrides. Later wins. */
export async function loadConfig(opts: LoadOptions): Promise<LoadedConfig> {
  const sources: Sources = {};
  const merged: Obj = {};
  apply(merged, defaultConfig({ nodeId: opts.nodeId ?? hostname() }), "default", sources);

  const homeLayer = await readLayer(join(opts.home, "config.yaml"), HomeConfigLayer);
  if (homeLayer) apply(merged, homeLayer.data, homeLayer.file, sources);

  const wsFile = join(opts.workspaceDir, ".heph", "workspace.yaml");
  const wsLayer = await readLayer(wsFile, WorkspaceConfig, ["workspace"]);
  const workspace = wsLayer?.data ?? impliedWorkspace(opts.workspaceDir);
  apply(merged, { workspace }, wsLayer?.file ?? "default", sources);
  if (!workspace.name) {
    const name =
      basename(resolve(opts.workspaceDir)).replace(/[^A-Za-z0-9._-]/g, "-") || "workspace";
    apply(merged, { workspace: { name } }, "default", sources);
  }

  const projects: Obj = {};
  for (const name of Object.keys(workspace.projects)) projects[name] = { commands: {} };
  merged.projects = projects;

  for (const [repo, repoPath] of Object.entries(workspace.repos)) {
    const file = join(resolve(opts.workspaceDir, repoPath), ".heph", "config.yaml");
    // A repo at the home directory: its .heph is the node's home, already read above.
    if (resolve(file) === resolve(opts.home, "config.yaml")) continue;
    const layer = await readLayer(file, RepoConfigLayer);
    if (!layer) continue;
    apply(merged, { projects: repoProjects(layer, repo, workspace) }, file, sources);
  }

  if (opts.overrides && Object.keys(opts.overrides).length > 0) {
    apply(merged, expand(opts.overrides), "flag", sources);
  }

  const parsed = ResolvedConfig.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const path = issue.path.map(String);
        if (issue.code === "unrecognized_keys" && issue.keys[0]) path.push(issue.keys[0]);
        const key = path.join(".");
        return { file: sourceOf(sources, key), key, message: issue.message };
      }),
    );
  }
  return { config: parsed.data, sources };
}

/** The source of a key, or of the nearest leaf under or above it. */
function sourceOf(sources: Sources, key: string): string {
  if (sources[key]) return sources[key];
  const under = Object.keys(sources).find((k) => k.startsWith(`${key}.`));
  if (under) return sources[under] as string;
  const parts = key.split(".");
  while (parts.pop() !== undefined && parts.length > 0) {
    const above = sources[parts.join(".")];
    if (above) return above;
  }
  return "flag";
}

function repoProjects(
  layer: FileLayer<RepoConfigLayer>,
  repo: string,
  workspace: WorkspaceConfig,
): Record<string, ProjectLayer> {
  const own = Object.entries(workspace.projects)
    .filter(([, p]) => p.repo === repo)
    .map(([name]) => name);
  const fail = (path: Path, message: string): never => {
    const line = findLine(layer.text, path);
    throw new ConfigError([
      { file: layer.file, ...(line ? { line } : {}), key: path.join("."), message },
    ]);
  };
  if (layer.data.project) {
    if (own.length !== 1) {
      fail(
        ["project"],
        `repo "${repo}" has ${own.length} projects; use projects.<name> (${own.join(", ") || "none"})`,
      );
    }
    return { [own[0] as string]: layer.data.project };
  }
  const projects = layer.data.projects ?? {};
  for (const name of Object.keys(projects)) {
    if (!(name in workspace.projects)) fail(["projects", name], `unknown project "${name}"`);
    if (!own.includes(name)) fail(["projects", name], `project "${name}" is not in repo "${repo}"`);
  }
  return projects;
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

export type HomeConfig = Pick<ResolvedConfig, "node" | "nodes" | "workspaces" | "sync">;

/** Only the node's own settings (no workspace): what `heph peer` and `heph sync` need. */
export async function loadHomeConfig(home: string, nodeId?: string): Promise<HomeConfig> {
  const d = defaultConfig({ nodeId: nodeId ?? hostname() });
  const layer = (await readLayer(join(home, "config.yaml"), HomeConfigLayer))?.data ?? {};
  return {
    node: { ...d.node, ...layer.node },
    nodes: { ...d.nodes, ...layer.nodes },
    workspaces: { ...d.workspaces, ...layer.workspaces },
    sync: { ...d.sync, ...layer.sync },
  };
}

/** `key = value  (source)` for every resolved leaf, in config order. */
export function explainConfig({ config, sources }: LoadedConfig): string[] {
  return leaves(config).map(
    ([key, value]) => `${key} = ${show(value)}  (${sourceOf(sources, key)})`,
  );
}

/** The nearest directory at or above `cwd` with `.heph/workspace.yaml`, else `cwd` itself. */
export function findWorkspace(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".heph", "workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(cwd);
    dir = up;
  }
}
