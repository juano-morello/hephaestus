import { realpathSync } from "node:fs";
import { resolveInside } from "./paths.ts";
import { run } from "./proc.ts";
import type { ContainerSpec, Sandbox } from "./sandbox.ts";

const ROOT = "/work";
/** Extra time the host waits beyond the in-container timeout before killing the exec client. */
const HOST_GRACE_MS = 5000;

export type ContainerSandbox = Sandbox & { readonly id: string };

/**
 * One container per unit attempt (SPEC section 12): only the project dir is mounted, at /work,
 * network is off, and it runs as the host user so the host can clean up what it writes.
 * Every path the model picks is resolved inside the container, never on the host.
 */
export async function openContainer(spec: ContainerSpec): Promise<ContainerSandbox> {
  const rt = spec.runtime ?? "docker";
  const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  const started = await run([
    rt,
    "run",
    "-d",
    "--rm",
    "--network",
    "none",
    "--user",
    user,
    "--label",
    "heph.sandbox=1",
    ...Object.entries(spec.labels ?? {}).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    "--cpus",
    String(spec.cpus ?? 2),
    "--memory",
    spec.memory ?? "2g",
    "-v",
    `${realpathSync(spec.hostDir)}:${ROOT}`,
    "-w",
    ROOT,
    spec.image,
    "sleep",
    "infinity",
  ]);
  if (started.code !== 0)
    throw new Error(`cannot start sandbox container: ${started.stderr.trim()}`);
  const id = started.stdout.trim();

  return {
    kind: "container",
    root: ROOT,
    id,
    async exec(command, opts = {}) {
      const cwd = resolveInside(ROOT, opts.cwd ?? ".");
      const limit =
        opts.timeoutMs === undefined
          ? []
          : ["timeout", "-s", "KILL", String(Math.ceil(opts.timeoutMs / 1000))];
      const r = await run(
        [
          rt,
          "exec",
          ...(opts.stdin === undefined ? [] : ["-i"]),
          "-w",
          cwd,
          "-e",
          "HOME=/tmp",
          id,
          ...limit,
          "sh",
          "-c",
          command,
        ],
        {
          ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs + HOST_GRACE_MS } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
      );
      // `timeout -s KILL` exits 137 when it had to kill the command.
      const killed = opts.timeoutMs !== undefined && r.code === 137;
      return { ...r, timedOut: r.timedOut || killed };
    },
    async readFile(path) {
      const abs = resolveInside(ROOT, path);
      const r = await run([rt, "exec", id, "cat", "--", abs]);
      if (r.code !== 0) throw new Error(`cannot read ${path}: ${r.stderr.trim()}`);
      return r.stdout;
    },
    async writeFile(path, content) {
      const abs = resolveInside(ROOT, path);
      const script = 'mkdir -p "$(dirname "$1")" && cat > "$1"';
      const r = await run([rt, "exec", "-i", id, "sh", "-c", script, "sh", abs], {
        stdin: content,
      });
      if (r.code !== 0) throw new Error(`cannot write ${path}: ${r.stderr.trim()}`);
    },
    async dispose() {
      await run([rt, "rm", "-f", id]);
    },
  };
}

export async function removeContainers(
  rt: "docker" | "podman",
  labels: Record<string, string>,
): Promise<number> {
  const filters = Object.entries({ "heph.sandbox": "1", ...labels }).flatMap(([k, v]) => [
    "--filter",
    `label=${k}=${v}`,
  ]);
  const listed = await run([rt, "ps", "-aq", ...filters]);
  if (listed.code !== 0) throw new Error(`cannot list sandbox containers: ${listed.stderr.trim()}`);
  const ids = listed.stdout.split("\n").filter(Boolean);
  if (ids.length) await run([rt, "rm", "-f", ...ids]);
  return ids.length;
}
