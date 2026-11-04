#!/usr/bin/env bun
// OMP's native addon for another platform, next to a cross-compiled heph (OMP's loader looks in
// the binary's directory). Fetched from npm at the exact version OMP pins, and checked against
// the registry's integrity hash before anything is written.
//
//   bun packages/cli/scripts/fetch-natives.ts linux-x64 dist
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [platform, outDir] = process.argv.slice(2);
if (!platform || !outDir)
  throw new Error("usage: fetch-natives.ts <platform, e.g. linux-x64> <out dir>");

// The version OMP itself resolved: pi-natives is OMP's dependency, reached from the workers package.
const omp = Bun.resolveSync(
  "@oh-my-pi/pi-coding-agent/package.json",
  join(import.meta.dir, "..", "..", "workers"),
);
const pkgJson = Bun.resolveSync("@oh-my-pi/pi-natives/package.json", join(omp, ".."));
const version = (JSON.parse(readFileSync(pkgJson, "utf8")) as { version: string }).version;
const name = `@oh-my-pi/pi-natives-${platform}`;
const meta = (await (
  await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`)
).json()) as {
  dist?: { tarball: string; integrity: string };
};
if (!meta.dist) throw new Error(`${name}@${version} is not on the registry`);

const tgz = new Uint8Array(await (await fetch(meta.dist.tarball)).arrayBuffer());
const [algo, expected] = meta.dist.integrity.split("-", 2) as [string, string];
const got = createHash(algo).update(tgz).digest("base64");
if (got !== expected) throw new Error(`${name}@${version}: integrity mismatch (${algo})`);

const tmp = mkdtempSync(join(tmpdir(), "heph-natives-"));
try {
  writeFileSync(join(tmp, "pkg.tgz"), tgz);
  const r = Bun.spawnSync(["tar", "-xzf", "pkg.tgz"], { cwd: tmp });
  if (r.exitCode !== 0) throw new Error(`tar: ${r.stderr.toString()}`);
  mkdirSync(outDir, { recursive: true });
  const addons = readdirSync(join(tmp, "package")).filter((f) => f.endsWith(".node"));
  if (!addons.length) throw new Error(`${name}@${version} has no .node file`);
  for (const f of addons) renameSync(join(tmp, "package", f), join(outDir, f));
  console.log(`${name}@${version} (${algo} verified): ${addons.join(", ")} -> ${outDir}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
