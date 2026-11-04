import { dirname } from "node:path";
import pkg from "../package.json";

declare const HEPH_BUILD: string | undefined;

/**
 * This heph's version, and the commit it was built from: stamped into a compiled binary by the
 * build (`--define HEPH_BUILD`), read from git when running from a checkout, else "unknown".
 */
export function hephVersion(): { version: string; build: string } {
  let build = typeof HEPH_BUILD === "string" ? HEPH_BUILD : "";
  if (!build) {
    const r = Bun.spawnSync(["git", "describe", "--always", "--dirty"], {
      cwd: dirname(import.meta.path),
      stderr: "ignore",
    });
    build = r.exitCode === 0 ? `${r.stdout.toString().trim()}, from source` : "unknown";
  }
  return { version: pkg.version, build };
}
