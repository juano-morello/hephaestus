import { lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** A role file larger than this is an error: it is prompt text, not a document. */
export const ROLE_FILE_LIMIT = 16 * 1024;

export type RoleFile = { role: string; path: string; layer: "home" | "repo" | "workspace" };

/** Roles whose prompts a repo can extend; the planner's comes from the workspace. */
const WORKER_ROLES = ["test_author", "implementer", "documenter"] as const;

/** The file's trimmed text; undefined when it is missing or blank. Anything else is an error. */
function readRoleFile(path: string): string | undefined {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // A link whose target moved is a broken file, not a missing one.
      let link = false;
      try {
        link = lstatSync(path).isSymbolicLink();
      } catch {}
      if (!link) return undefined;
    }
    throw new Error(`can't read role file ${path}: ${(e as Error).message}`);
  }
  if (size > ROLE_FILE_LIMIT) throw new Error(`role file ${path} is over 16 KB`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`can't read role file ${path}: ${(e as Error).message}`);
  }
  // The size above is a cheap early exit; the text is what counts.
  if (Buffer.byteLength(text) > ROLE_FILE_LIMIT) throw new Error(`role file ${path} is over 16 KB`);
  return text.trim() ? text.trim() : undefined;
}

const homePath = (home: string, role: string) => join(home, "roles", `${role}.md`);
const dirPath = (dir: string, role: string) => join(dir, ".heph", "roles", `${role}.md`);

/** Home text, then the repo's (or the workspace's, for the planner), as one string. */
export function roleInstructions(o: {
  home: string;
  dir: string;
  dirLayer: "repo" | "workspace";
  role: string;
}): string | undefined {
  const parts = [readRoleFile(homePath(o.home, o.role)), readRoleFile(dirPath(o.dir, o.role))];
  const text = parts.filter((p): p is string => p !== undefined).join("\n\n");
  return text || undefined;
}

/** Every role file in effect, for `heph config explain` and the dry run. */
export function listRoleFiles(o: {
  home: string;
  workspaceDir: string;
  repoDirs: string[];
}): RoleFile[] {
  const out: RoleFile[] = [];
  const seen = new Set<string>();
  const add = (role: string, path: string, layer: RoleFile["layer"]) => {
    if (seen.has(path)) return;
    seen.add(path);
    if (readRoleFile(path) !== undefined) out.push({ role, path, layer });
  };
  for (const role of ["planner", ...WORKER_ROLES]) add(role, homePath(o.home, role), "home");
  add("planner", dirPath(o.workspaceDir, "planner"), "workspace");
  for (const dir of o.repoDirs)
    for (const role of WORKER_ROLES) add(role, dirPath(dir, role), "repo");
  return out;
}
