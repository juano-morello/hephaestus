// The only process-spawning module (SPEC section 3), so a Node implementation can replace it.

export type ProcResult = { code: number; stdout: string; stderr: string; timedOut: boolean };

export type ProcOptions = {
  cwd?: string;
  env?: Record<string, string>;
  /** false: the command sees only `env`, nothing from this process. Default true. */
  inheritEnv?: boolean;
  stdin?: string;
  /** Kill the command (SIGKILL) after this long. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export async function run(cmd: string[], opts: ProcOptions = {}): Promise<ProcResult> {
  const proc = Bun.spawn(cmd, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: opts.inheritEnv === false ? { ...opts.env } : { ...process.env, ...opts.env },
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer =
    opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          proc.kill("SIGKILL");
        }, opts.timeoutMs);
  const onAbort = () => proc.kill("SIGKILL");
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Like run, but throws on a non-zero exit and returns stdout. */
export async function runOk(cmd: string[], opts: ProcOptions = {}): Promise<string> {
  const r = await run(cmd, opts);
  if (r.code !== 0) throw new Error(`${cmd.join(" ")} exited ${r.code}: ${r.stderr.trim()}`);
  return r.stdout;
}
