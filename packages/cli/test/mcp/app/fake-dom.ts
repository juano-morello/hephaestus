// A minimal DOM and fake host for testing the MCP App pages without a browser. Any use of
// innerHTML/outerHTML/insertAdjacentHTML throws, so a page that builds markup from model text fails loudly.
export class FakeEl {
  children: FakeEl[] = [];
  attrs: Record<string, string> = {};
  style = {
    props: {} as Record<string, string>,
    setProperty(k: string, v: string) {
      this.props[k] = v;
    },
  };
  className = "";
  scrollWidth = 320;
  scrollHeight = 480;
  private text = "";
  isText = false;
  disabled = false;
  listeners: Record<string, (() => void)[]> = {};
  constructor(public tag: string) {}
  get textContent(): string {
    return this.isText || this.children.length === 0
      ? this.text
      : this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.children = [];
    this.text = String(v);
  }
  appendChild(c: FakeEl) {
    this.children.push(c);
    return c;
  }
  append(...cs: (FakeEl | string)[]) {
    for (const c of cs) {
      if (typeof c === "string") {
        const t = new FakeEl("#text");
        t.isText = true;
        t.text = c;
        this.children.push(t);
      } else this.children.push(c);
    }
  }
  replaceChildren(...cs: FakeEl[]) {
    this.children = [];
    this.text = "";
    this.append(...cs);
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners[type] = [...(this.listeners[type] ?? []), fn];
  }
  /** A user click: runs the click listeners unless the element is disabled. */
  click() {
    if (this.disabled) return;
    for (const fn of this.listeners.click ?? []) fn();
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  find(pred: (e: FakeEl) => boolean): FakeEl[] {
    return [...(pred(this) ? [this] : []), ...this.children.flatMap((c) => c.find(pred))];
  }
  byClass(cls: string): FakeEl[] {
    return this.find((e) => e.className.split(" ").includes(cls));
  }
}
for (const p of ["innerHTML", "outerHTML"])
  Object.defineProperty(FakeEl.prototype, p, {
    set() {
      throw new Error(`${p} is forbidden: plan text must go in through textContent`);
    },
    get() {
      throw new Error(`${p} is forbidden`);
    },
  });
(FakeEl.prototype as unknown as Record<string, unknown>).insertAdjacentHTML = () => {
  throw new Error("insertAdjacentHTML is forbidden");
};

export type Sent = {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
};

export type FakeHostOpts = {
  hostCapabilities?: Record<string, unknown>;
  variables?: Record<string, string>;
  theme?: string;
  containerDimensions?: Record<string, unknown>;
  /** Do not answer ui/initialize. */
  silent?: boolean;
};

/** A window whose parent is a fake host speaking the MCP Apps handshake. */
export function fakeHost(opts: FakeHostOpts = {}) {
  const root = new FakeEl("html");
  const body = new FakeEl("body");
  root.appendChild(body);
  const listeners: ((ev: { data: unknown; source: unknown }) => void)[] = [];
  const sent: Sent[] = [];
  const parent = {
    postMessage(msg: Sent) {
      sent.push(msg);
      if (msg.method === "ui/initialize" && !opts.silent)
        queueMicrotask(() =>
          deliver({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2026-01-26",
              hostCapabilities: opts.hostCapabilities ?? {},
              hostInfo: { name: "fake-host", version: "1" },
              hostContext: {
                theme: opts.theme ?? "light",
                ...(opts.containerDimensions
                  ? { containerDimensions: opts.containerDimensions }
                  : {}),
                styles: { variables: opts.variables ?? {} },
              },
            },
          }),
        );
    },
  };
  const win = {
    parent,
    addEventListener: (_: string, fn: (ev: { data: unknown; source: unknown }) => void) =>
      listeners.push(fn),
  };
  const docListeners: Record<string, ((ev: unknown) => void)[]> = {};
  const doc = {
    documentElement: root,
    body,
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      docListeners[type] = [...(docListeners[type] ?? []), fn];
    },
    createElement: (t: string) => new FakeEl(t),
    createTextNode: (t: string) => {
      const e = new FakeEl("#text");
      e.isText = true;
      e.textContent = t;
      return e;
    },
  };
  const deliver = (data: unknown, source: unknown = parent) => {
    for (const l of listeners) l({ data, source });
  };
  const notify = (method: string, params: unknown) => deliver({ jsonrpc: "2.0", method, params });
  const tick = () => new Promise((r) => setTimeout(r, 5));
  /** Fires a document event, e.g. a securitypolicyviolation. */
  const fire = (type: string, ev: unknown) => {
    for (const fn of docListeners[type] ?? []) fn(ev);
  };
  return { win, doc, root, body, sent, deliver, notify, tick, parent, fire };
}
