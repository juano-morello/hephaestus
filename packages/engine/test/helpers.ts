import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runOk } from "../src/proc.ts";

/** A fresh temp dir per call, removed after each test. */
export function tempDir(): () => string {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  return () => {
    const d = mkdtempSync(join(tmpdir(), "heph-engine-"));
    dirs.push(d);
    return d;
  };
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** A git repo with one commit on main containing `files`. */
export async function initRepo(dir: string, files: Record<string, string>): Promise<string> {
  const git = (...args: string[]) => runOk(["git", ...args], { cwd: dir });
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.com");
  writeFiles(dir, files);
  await git("add", "-A");
  await git("commit", "-q", "-m", "base");
  return dir;
}
