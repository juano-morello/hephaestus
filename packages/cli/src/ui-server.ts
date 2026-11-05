// The daemon's read-only dashboard listener. Unlike the Unix socket this is a network surface
// (loopback only), so it is narrow on purpose: it forwards just the read methods below, needs a
// bearer token for them, and refuses any Host header that is not the loopback address (which
// also defeats DNS rebinding). The static bundle needs no token; the token lives in $HEPH_HOME/ui.json.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The only api methods the listener forwards; everything that writes stays off the network. */
export const UI_METHODS = ["status", "explain", "planShow", "dashboard"] as const;
export const DEFAULT_UI_PORT = 7878;
const MAX_BODY = 1024 * 1024;

export const uiFileOf = (home: string) => join(home, "ui.json");

/** The bundle to serve, keyed by request path (`"/"`, `"/assets/app.js"`, ...). */
export type UiAssets = Record<string, { body: string | Uint8Array | Blob; type: string }>;

type UiFile = { port: number; token: string };

/** The listener's port and token as the last daemon wrote them, or undefined. */
export function readUiFile(home: string): UiFile | undefined {
  try {
    const j = JSON.parse(readFileSync(uiFileOf(home), "utf8")) as Partial<UiFile>;
    if (Number.isInteger(j.port) && typeof j.token === "string" && j.token.length >= 32)
      return { port: j.port as number, token: j.token };
  } catch {}
  return undefined;
}

const sameToken = (given: string, token: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

export async function startUiServer(o: {
  home: string;
  call: (method: string, args: unknown[]) => Promise<unknown>;
  assets: UiAssets;
  port?: number;
  log?: (line: string) => void;
}): Promise<{ port: number; token: string; stop(): Promise<void> } | undefined> {
  // The token outlives the daemon so an open dashboard tab keeps working across restarts.
  const token = readUiFile(o.home)?.token ?? randomBytes(32).toString("base64url");
  let port = 0;
  const fetch = async (req: Request): Promise<Response> => {
    const host = req.headers.get("host");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
      return new Response("forbidden", { status: 403 });
    const path = new URL(req.url).pathname;
    if (!path.startsWith("/api/")) {
      const a = req.method === "GET" || req.method === "HEAD" ? o.assets[path] : undefined;
      if (!a) return new Response("not found", { status: 404 });
      return new Response(a.body, { headers: { "content-type": a.type } });
    }
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
    if (!bearer?.[1] || !sameToken(bearer[1], token))
      return new Response("unauthorized", { status: 401 });
    const method = path.slice("/api/".length);
    if (!(UI_METHODS as readonly string[]).includes(method))
      return new Response("not found", { status: 404 });
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_BODY) return new Response("body too large", { status: 400 });
    let args: unknown[];
    try {
      const text = await req.text();
      if (text.length > MAX_BODY) return new Response("body too large", { status: 400 });
      const body = JSON.parse(text) as { args?: unknown };
      if (!Array.isArray(body.args)) return new Response("args must be an array", { status: 400 });
      args = body.args;
    } catch {
      return new Response("bad request", { status: 400 });
    }
    try {
      return Response.json({ ok: true, data: await o.call(method, args) });
    } catch (e) {
      return Response.json({
        ok: false,
        error: { message: e instanceof Error ? e.message : String(e) },
      });
    }
  };
  const bind = (p: number) =>
    // Bun's own cap sits above ours so an oversized body reaches the handler and gets a 400.
    Bun.serve({ hostname: "127.0.0.1", port: p, maxRequestBodySize: 4 * MAX_BODY, fetch });
  let server: ReturnType<typeof bind>;
  try {
    server = bind(o.port ?? DEFAULT_UI_PORT);
  } catch (e) {
    if ((e as { code?: string }).code !== "EADDRINUSE") {
      o.log?.(`dashboard not started: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
    o.log?.(`dashboard port ${o.port ?? DEFAULT_UI_PORT} is taken; picking another`);
    try {
      server = bind(0);
    } catch (e2) {
      o.log?.(`dashboard not started: ${e2 instanceof Error ? e2.message : String(e2)}`);
      return undefined;
    }
  }
  port = server.port as number;
  const file = uiFileOf(o.home);
  writeFileSync(file, JSON.stringify({ port, token }), { mode: 0o600 });
  chmodSync(file, 0o600); // the mode above only applies to a new file, and the umask trims it
  return {
    port,
    token,
    async stop() {
      await server.stop(true);
    },
  };
}
