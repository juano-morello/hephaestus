import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runOk } from "@hephaestus/sandbox";

export function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export const git = (cwd: string, ...args: string[]) =>
  runOk(["git", "-c", "user.name=T", "-c", "user.email=t@x", ...args], { cwd });

/** A repo with one commit on main and a bare clone of it as `origin`. Returns the origin path. */
export async function repoWithOrigin(dir: string, files: Record<string, string>, origins: string) {
  mkdirSync(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  for (const [p, c] of Object.entries(files)) put(join(dir, p), c);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", "base");
  const origin = join(origins, `${dir.split("/").at(-1)}.git`);
  await runOk(["git", "clone", "-q", "--bare", dir, origin]);
  await git(dir, "remote", "add", "origin", origin);
  await git(dir, "fetch", "-q", "origin");
  return origin;
}
