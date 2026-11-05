import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { checkContrast } from "./contrast.ts";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

const problems = checkContrast(await Bun.file(join(root, "src/theme.css")).text());
if (problems.length) {
  console.error(`theme contrast check failed:\n${problems.join("\n")}`);
  process.exit(1);
}

const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) {
    console.error(`build step failed: ${cmd.join(" ")}`);
    process.exit(1);
  }
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await run([
  "bun",
  "build",
  "src/main.tsx",
  "--outdir",
  "dist",
  "--entry-naming",
  "app.[ext]",
  "--minify",
]);
await run([
  join(root, "node_modules/.bin/tailwindcss"),
  "-i",
  "src/theme.css",
  "-o",
  "dist/app.css",
  "--minify",
]);
await cp(join(root, "src/index.html"), join(dist, "index.html"));
// Typings so the CLI can import these files as `{ type: "file" }` (a path string).
const pathType = "declare const path: string;\nexport default path;\n";
await Bun.write(join(dist, "app.d.ts"), pathType);
await Bun.write(join(dist, "app.d.css.ts"), pathType);
console.log("built packages/ui/dist");
