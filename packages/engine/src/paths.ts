import { posix } from "node:path";

/** "./client/" -> "client/"; the repo root (".", "", "./") -> "". */
export const prefixOf = (projectPath: string) => {
  const p = posix.normalize(projectPath).replace(/^\.\//, "").replace(/\/+$/, "");
  return p === "" || p === "." ? "" : `${p}/`;
};

/** Repo-relative path -> project-relative, or undefined when it is outside the project. */
export function projectRelative(projectPath: string, repoPath: string): string | undefined {
  const prefix = prefixOf(projectPath);
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : undefined;
}

/** "./a//b.go" -> "a/b.go", for comparing paths a worker reported. */
export const normalizePath = (p: string) => posix.normalize(p).replace(/^\.\//, "");
