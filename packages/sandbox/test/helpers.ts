import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A fresh temp dir per call, removed after each test. On macOS it lives under the home
 * directory, because Colima only mounts $HOME into its VM.
 */
export function tempDir(): () => string {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const root = process.platform === "darwin" ? join(homedir(), ".cache", "heph-tests") : tmpdir();
  return () => {
    const d = mkdtempSync(join(root, "sandbox-"));
    dirs.push(d);
    return d;
  };
}
