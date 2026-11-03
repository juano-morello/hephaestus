import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh temp dir per call; under $HOME on macOS so Colima can mount it. */
export function tempDir(): () => string {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const root = process.platform === "darwin" ? join(homedir(), ".cache", "heph-tests") : tmpdir();
  return () => {
    const d = mkdtempSync(join(root, "workers-"));
    dirs.push(d);
    return d;
  };
}
