import { posix } from "node:path";

/**
 * Resolves `path` against `root` and refuses anything that lands outside it. Lexical only:
 * modes that can see the real filesystem also check symlinks (see native.ts).
 */
export function resolveInside(root: string, path: string): string {
  const base = posix.normalize(root).replace(/\/+$/, "") || "/";
  const abs = posix
    .normalize(posix.isAbsolute(path) ? path : posix.join(base, path))
    .replace(/\/+$/, "");
  if (abs !== base && !abs.startsWith(`${base}/`))
    throw new Error(`path escapes the sandbox: ${path}`);
  return abs || "/";
}
