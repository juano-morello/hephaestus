import type { PeerNode } from "@hephaestus/core";
import { answer, type Methods, PeerError, type Request, type Response } from "./protocol.ts";

/** A connection to one peer. */
export type Transport = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  close(): Promise<void>;
};

/** In this process, through a JSON round trip so the wire format is exercised. Tests use it. */
export function localTransport(methods: Methods): Transport {
  let id = 0;
  return {
    async request<T>(method: string, params: unknown = {}) {
      const res = await answer(methods, JSON.stringify({ id: ++id, method, params }));
      const back = JSON.parse(JSON.stringify(res)) as Response;
      if (!back.ok) throw new PeerError(back.error.message);
      return back.result as T;
    },
    async close() {},
  };
}

/** Speaks the protocol to a child process (`heph peer`, locally or through ssh). */
export function processTransport(cmd: string[], env?: Record<string, string>): Transport {
  const proc = Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  let id = 0;
  const waiting = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>();
  let failed: Error | undefined;
  let stderr = "";

  const fail = (e: Error) => {
    failed ??= e;
    for (const w of waiting.values()) w.reject(failed);
    waiting.clear();
  };

  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line) continue;
        try {
          const res = JSON.parse(line) as Response;
          waiting.get(res.id)?.resolve(res);
          waiting.delete(res.id);
        } catch {
          // Not a response (a banner or a stray log line); ignore it.
        }
      }
    }
  })();
  void (async () => {
    for await (const chunk of proc.stderr) stderr += new TextDecoder().decode(chunk);
  })();
  void proc.exited.then((code) =>
    fail(
      new PeerError(
        `${cmd.join(" ")} exited with ${code}${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`,
      ),
    ),
  );

  return {
    request<T>(method: string, params: unknown = {}) {
      if (failed) return Promise.reject(failed);
      const req: Request = { id: ++id, method, params };
      return new Promise<T>((resolve, reject) => {
        waiting.set(req.id, {
          resolve: (r) => (r.ok ? resolve(r.result as T) : reject(new PeerError(r.error.message))),
          reject,
        });
        proc.stdin.write(`${JSON.stringify(req)}\n`);
        proc.stdin.flush();
      });
    },
    async close() {
      try {
        proc.stdin.end();
      } catch {
        // Already closed.
      }
      const done = await Promise.race([proc.exited, Bun.sleep(2000).then(() => undefined)]);
      if (done === undefined) proc.kill();
    },
  };
}

/** How long to wait for a peer to answer ssh before calling it unreachable. */
const CONNECT_TIMEOUT_S = 5;

/** `ssh <host> <heph> peer`: the peer runs as you, authenticated by your SSH keys. */
export function sshCommand(peer: PeerNode): string[] {
  const remote = [peer.heph ?? "heph", "peer", ...(peer.home ? ["--home", peer.home] : [])];
  return [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
    "-o",
    "ServerAliveInterval=15",
    peer.ssh,
    "--",
    ...remote,
  ];
}

export const sshTransport = (peer: PeerNode): Transport => processTransport(sshCommand(peer));

/**
 * The far side's loop (`heph peer`): one request per stdin line, one response per stdout line,
 * answered in order. Ends when stdin closes.
 */
export async function servePeer(
  methods: Methods,
  io: {
    lines: AsyncIterable<string>;
    write: (s: string) => void;
  },
): Promise<void> {
  for await (const line of io.lines) {
    if (!line.trim()) continue;
    io.write(`${JSON.stringify(await answer(methods, line))}\n`);
  }
}

/** stdin as lines, for servePeer. */
export async function* stdinLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  if (buf.trim()) yield buf;
}
