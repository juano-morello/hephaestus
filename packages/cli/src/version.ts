import { dirname } from "node:path";
import pkg from "../package.json";

declare const HEPH_BUILD: string | undefined;

type Spawn = (
  cmd: string[],
  o: { cwd: string; stderr: "ignore" },
) => { exitCode: number | null; stdout: { toString(): string } };

/**
 * This heph's version, and the commit it was built from: stamped into a compiled binary by the
 * build (`--define HEPH_BUILD`), read from git when running from a checkout, else "unknown".
 * A compiled binary's own directory is inside the virtual `/$bunfs`, where git cannot even be
 * spawned, so a failed spawn is "unknown" too.
 */
export function hephVersion(o: { spawn?: Spawn } = {}): { version: string; build: string } {
  let build = typeof HEPH_BUILD === "string" ? HEPH_BUILD : "";
  if (!build) {
    const spawn: Spawn = o.spawn ?? ((cmd, opts) => Bun.spawnSync(cmd, opts));
    try {
      const r = spawn(["git", "describe", "--always", "--dirty"], {
        cwd: dirname(import.meta.path),
        stderr: "ignore",
      });
      build = r.exitCode === 0 ? `${r.stdout.toString().trim()}, from source` : "unknown";
    } catch {
      build = "unknown";
    }
  }
  return { version: pkg.version, build };
}
