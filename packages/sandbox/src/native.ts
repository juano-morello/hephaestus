import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveInside } from "./paths.ts";
import { run } from "./proc.ts";
import type { NativeSpec, Sandbox } from "./sandbox.ts";

/** Realpath of the nearest existing ancestor must stay inside root, so symlinks can't escape. */
function confine(root: string, path: string): string {
  const abs = resolveInside(root, path);
  let probe = abs;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  if (real !== root && !real.startsWith(`${root}/`))
    throw new Error(`path escapes the sandbox: ${path}`);
  return abs;
}

export function openNative(spec: NativeSpec): Sandbox {
  const root = realpathSync(spec.hostDir);
  // Commands get no credentials: only these variables reach them.
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", HOME: root };
  return {
    kind: "native",
    root,
    exec: async (command, opts = {}) =>
      run(["sh", "-c", command], {
        cwd: confine(root, opts.cwd ?? "."),
        env,
        inheritEnv: false,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      }),
    readFile: async (path) => readFile(confine(root, path), "utf8"),
    writeFile: async (path, content) => {
      const abs = confine(root, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    },
    dispose: async () => {},
  };
}
