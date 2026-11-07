// The page side of the MCP Apps handshake (SEP-1865), shared by every heph widget. Runs in the
// browser, inside the host's iframe: JSON-RPC over window.parent.postMessage. Bundled into each
// page by scripts/build-apps.ts, so it must not import anything that is not browser-safe.

type Win = {
  parent: { postMessage(msg: unknown, target: string): void };
  addEventListener(type: "message", fn: (ev: { data: unknown; source: unknown }) => void): void;
};
type El = {
  style: { setProperty(k: string, v: string): void };
  setAttribute(k: string, v: string): void;
};
type Doc = { documentElement: El };

export type ToolResult = {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
};

export type Host = {
  /** Resolves when the host answered ui/initialize (and the page told it so); rejects if it refused. */
  ready: Promise<void>;
  /** The host can call this server's tools on the page's behalf (hostCapabilities.serverTools). */
  hasServerTools: boolean;
  /** Called with every tool result the host pushes; a result that came earlier is replayed. */
  onToolResult(fn: (r: ToolResult) => void): void;
};

const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** Put the host's theme on the page: its CSS variables on :root, and the theme name. */
function applyContext(doc: Doc, ctx: unknown): void {
  const c = rec(ctx);
  if (!c) return;
  const vars = rec(rec(c.styles)?.variables);
  if (vars)
    for (const [k, v] of Object.entries(vars))
      if (k.startsWith("--") && typeof v === "string") doc.documentElement.style.setProperty(k, v);
  if (typeof c.theme === "string") doc.documentElement.setAttribute("data-theme", c.theme);
}

export function connectHost(win: Win, doc: Doc, app: { name: string; version: string }): Host {
  let n = 0;
  const pending = new Map<number, { ok(r: unknown): void; fail(e: Error): void }>();
  let handler: ((r: ToolResult) => void) | undefined;
  let early: ToolResult | undefined;
  const send = (msg: unknown) => win.parent.postMessage(msg, "*");

  const host: Host = {
    hasServerTools: false,
    ready: Promise.resolve(),
    onToolResult(fn) {
      handler = fn;
      if (early) {
        const r = early;
        early = undefined;
        fn(r);
      }
    },
  };

  win.addEventListener("message", (ev) => {
    if (ev.source !== win.parent) return;
    const m = rec(ev.data);
    if (!m) return;
    const id = typeof m.id === "number" ? m.id : undefined;
    if (typeof m.method === "string") {
      // A request from the host: answer it, we have nothing to say. A notification: act on it.
      if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
      if (m.method === "ui/notifications/tool-result") {
        const r = (rec(m.params) ?? {}) as ToolResult;
        if (handler) handler(r);
        else early = r;
      } else if (m.method === "ui/notifications/host-context-changed") applyContext(doc, m.params);
    } else if (id !== undefined) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      const err = rec(m.error);
      if (err) p.fail(new Error(typeof err.message === "string" ? err.message : "host error"));
      else p.ok(m.result);
    }
  });

  host.ready = new Promise<unknown>((ok, fail) => {
    const id = ++n;
    pending.set(id, { ok, fail });
    send({
      jsonrpc: "2.0",
      id,
      method: "ui/initialize",
      params: { appInfo: app, appCapabilities: {}, protocolVersion: "2026-01-26" },
    });
  }).then((result) => {
    const r = rec(result);
    host.hasServerTools = rec(r?.hostCapabilities)?.serverTools !== undefined;
    applyContext(doc, r?.hostContext);
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  });
  return host;
}
