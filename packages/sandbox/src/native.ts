import { existsSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveInside } from "./paths.ts";
import { run, which } from "./proc.ts";
import type { NativeSpec, Sandbox } from "./sandbox.ts";

/** Credentials a command has no business reading, relative to the home directory. */
const SENSITIVE = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gh",
  ".config/gcloud",
  ".omp",
  ".docker",
  ".kube",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "Library/Keychains",
];

export const defaultDenyRead = (home = homedir()) => SENSITIVE.map((p) => join(home, p));

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

const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
const sbplString = (p: string) => JSON.stringify(p);

function macProfile(root: string, denyRead: string[]): string {
  const tmp = real(tmpdir());
  const deny = denyRead.map((p) => `(subpath ${sbplString(real(p))})`).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny network-outbound)",
    "(allow network-outbound (remote unix-socket))",
    // Loopback, for tests that start a server and connect to it. On macOS this also reaches
    // the host's own loopback services; bwrap on Linux gives the command a private loopback.
    '(allow network-outbound (remote ip "localhost:*"))',
    "(deny file-write*)",
    `(allow file-write* (subpath ${sbplString(root)}) (subpath ${sbplString(tmp)}) (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (regex #"^/dev/fd/") (regex #"^/dev/tty"))`,
    ...(deny ? [`(deny file-read* ${deny})`] : []),
  ].join("\n");
}

function bwrapArgs(bwrap: string, root: string, cwd: string, denyRead: string[]): string[] {
  const hide = denyRead
    .filter((p) => existsSync(p))
    .flatMap((p) => (statSync(p).isDirectory() ? ["--tmpfs", p] : ["--ro-bind", "/dev/null", p]));
  return [
    bwrap,
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--bind",
    root,
    root,
    ...hide,
    "--unshare-net",
    "--die-with-parent",
    "--chdir",
    cwd,
  ];
}

/** The command prefix that confines a shell command on this platform. */
function confiner(root: string, denyRead: string[]): (cwd: string) => string[] {
  if (process.platform === "darwin") {
    const sandboxExec = which("sandbox-exec");
    if (sandboxExec) {
      const profile = macProfile(root, denyRead);
      return () => [sandboxExec, "-p", profile];
    }
  } else if (process.platform === "linux") {
    const bwrap = which("bwrap");
    if (bwrap) return (cwd) => bwrapArgs(bwrap, root, cwd, denyRead);
  }
  throw new Error("native sandbox needs sandbox-exec (macOS) or bwrap (Linux) to confine commands");
}

let goModCache: string | undefined | null = null;
/** The host's Go module cache, if Go is installed: looked up once. */
function hostGoModCache(): string | undefined {
  if (goModCache === null) {
    const go = which("go");
    const out = go ? Bun.spawnSync([go, "env", "GOMODCACHE"]).stdout.toString().trim() : "";
    // Even when it doesn't exist yet: Go still gets the offline settings and a temp build cache.
    goModCache = out || undefined;
  }
  return goModCache;
}

/** The host's bun package cache, when it exists: a sandbox HOME is scratch, so bun can't find it. */
function hostBunCache(): string | undefined {
  const dir = process.env.BUN_INSTALL_CACHE_DIR ?? join(homedir(), ".bun", "install", "cache");
  return existsSync(dir) ? dir : undefined;
}

/**
 * Toolchain settings that let a confined command build offline. Go reads the host's module
 * cache (readable, never written: writes outside the project and temp are denied) with the
 * proxy off, so a missing module fails at once instead of on the blocked network; its build
 * cache lives in temp, shared by attempts.
 */
function toolchainEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const bunCache = hostBunCache();
  if (bunCache) env.BUN_INSTALL_CACHE_DIR = bunCache;
  const modcache = hostGoModCache();
  if (modcache)
    Object.assign(env, {
      GOMODCACHE: modcache,
      GOPROXY: "off",
      GOTOOLCHAIN: "local",
      GOCACHE: join(tmpdir(), "heph-go-build"),
    });
  return env;
}

export function openNative(spec: NativeSpec): Sandbox {
  const root = realpathSync(spec.hostDir);
  const prefix = confiner(root, spec.denyRead ?? defaultDenyRead());
  // Commands get no credentials: only these variables reach them. HOME is a scratch directory,
  // so caches tools keep there don't land in the project (and in the unit's diff).
  const home = mkdtempSync(join(tmpdir(), "heph-home-"));
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: home,
    ...toolchainEnv(),
  };
  return {
    kind: "native",
    root,
    exec: async (command, opts = {}) => {
      const cwd = confine(root, opts.cwd ?? ".");
      return run([...prefix(cwd), "sh", "-c", command], {
        cwd,
        env,
        inheritEnv: false,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      });
    },
    readFile: async (path) => readFile(confine(root, path), "utf8"),
    writeFile: async (path, content) => {
      const abs = confine(root, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    },
    dispose: async () => {
      await rm(home, { recursive: true, force: true });
    },
  };
}
