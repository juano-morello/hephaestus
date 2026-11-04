import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ProjectCommands } from "@hephaestus/core";

export type DetectedProject = {
  repo: string;
  path: string;
  stack: string;
  commands: ProjectCommands;
};
export type Detected = { repos: Record<string, string>; projects: Record<string, DetectedProject> };

const SKIP = new Set(["node_modules", "vendor", "dist", "build", "target", "out"]);

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const subdirs = (dir: string) =>
  readdirSync(dir)
    .filter((n) => !n.startsWith(".") && !SKIP.has(n) && isDir(join(dir, n)))
    .sort();

/** The stack a directory holds, judged by its marker files; undefined if none. */
function stackOf(dir: string): string | undefined {
  const has = (f: string) => existsSync(join(dir, f));
  if (has("go.mod")) return "go";
  if (has("Cargo.toml")) return "rust";
  if (has("package.json")) return "ts";
  if (has("project.godot")) return "godot";
  if (has("pyproject.toml")) return "python";
  if (has("buf.yaml") || readdirSync(dir).some((f) => f.endsWith(".proto"))) return "schema";
  return undefined;
}

/** Sensible starting commands per stack; edit them in <repo>/.heph/config.yaml. */
function commandsFor(stack: string, dir: string): ProjectCommands {
  switch (stack) {
    case "go":
      return { test: "go test ./...", typecheck: "go vet ./..." };
    case "rust":
      return { test: "cargo test", typecheck: "cargo check", lint: "cargo clippy -- -D warnings" };
    case "python":
      return { test: "pytest" };
    case "schema":
      return existsSync(join(dir, "buf.yaml")) ? { lint: "buf lint" } : {};
    case "ts": {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      const runner =
        existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb")) ? "bun" : "npm";
      const out: ProjectCommands = {};
      for (const key of ["test", "typecheck", "lint"] as const) {
        if (pkg.scripts?.[key]) out[key] = `${runner} run ${key}`;
      }
      return out;
    }
    default:
      return {};
  }
}

/** Projects in one repo: the repo root if it has a stack, else its subdirectories (two levels). */
function projectsIn(repo: string, repoDir: string): Record<string, DetectedProject> {
  const at = (
    name: string,
    path: string,
    dir: string,
    stack: string,
  ): [string, DetectedProject] => [name, { repo, path, stack, commands: commandsFor(stack, dir) }];
  const root = stackOf(repoDir);
  if (root) return Object.fromEntries([at(repo, ".", repoDir, root)]);
  const found: [string, DetectedProject][] = [];
  for (const sub of subdirs(repoDir)) {
    const dir = join(repoDir, sub);
    const stack = stackOf(dir);
    if (stack) {
      found.push(at(sub, sub, dir, stack));
      continue;
    }
    for (const inner of subdirs(dir)) {
      const innerStack = stackOf(join(dir, inner));
      if (innerStack) {
        found.push(at(sub, `${sub}/${inner}`, join(dir, inner), innerStack));
        break;
      }
    }
  }
  return found.length
    ? Object.fromEntries(found)
    : { [repo]: { repo, path: ".", stack: "unknown", commands: {} } };
}

/** Repos (the directory itself, or its git subdirectories) and the projects inside them. */
export function detectWorkspace(dir: string): Detected {
  const root = resolve(dir);
  const repos: Record<string, string> = existsSync(join(root, ".git"))
    ? { [basename(root)]: "." }
    : Object.fromEntries(
        subdirs(root)
          .filter((s) => existsSync(join(root, s, ".git")))
          .map((s) => [s, `./${s}`]),
      );
  if (!Object.keys(repos).length) throw new Error(`no git repository found in or under ${root}`);
  const projects: Record<string, DetectedProject> = {};
  for (const [repo, path] of Object.entries(repos))
    Object.assign(projects, projectsIn(repo, resolve(root, path)));
  return { repos, projects };
}

export type InitResult = Detected & { workspaceDir: string; written: string[] };

const HEADER =
  "# Written by heph init. Edit freely; heph config explain shows the resolved values.\n";

/** heph init: writes .heph/workspace.yaml and <repo>/.heph/config.yaml; never overwrites unless forced. */
export function initWorkspace(dir: string, opts: { force?: boolean } = {}): InitResult {
  const workspaceDir = resolve(dir);
  const detected = detectWorkspace(workspaceDir);
  const files = new Map<string, unknown>();
  files.set(join(workspaceDir, ".heph", "workspace.yaml"), {
    repos: detected.repos,
    projects: Object.fromEntries(
      Object.entries(detected.projects).map(([n, p]) => [
        n,
        { repo: p.repo, path: p.path, stack: p.stack },
      ]),
    ),
  });
  for (const [repo, path] of Object.entries(detected.repos)) {
    const projects = Object.entries(detected.projects).filter(([, p]) => p.repo === repo);
    files.set(join(workspaceDir, path, ".heph", "config.yaml"), {
      projects: Object.fromEntries(projects.map(([n, p]) => [n, { commands: p.commands }])),
    });
  }
  if (!opts.force) {
    for (const f of files.keys()) {
      if (existsSync(f)) throw new Error(`${f} already exists (use --force to overwrite)`);
    }
  }
  for (const [f, data] of files) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, `${HEADER}${Bun.YAML.stringify(data, null, 2)}\n`);
  }
  return { ...detected, workspaceDir, written: [...files.keys()] };
}
