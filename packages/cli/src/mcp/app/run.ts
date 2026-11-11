// The run view widget: renders heph_status's structuredContent, one run (units as a dependency
// graph, attempts, usage, pull requests) or the list of runs. Read-only by design: the controls are
// Refresh (only where the host can call this server's tools back: Codex, not Claude desktop) and
// choosing a run from the list and going back; there are no cancel, hint or approve buttons.
// When the tool result's `_meta.heph.live` names the daemon's dashboard (loopback only), the page
// polls its read-only status and dashboard methods every 2 s itself, so it is live in any host; if
// that fails it keeps the last view, says so, and leaves the host's path (Refresh) to take over.
// Everything model- or user-written goes in through textContent; nothing builds markup from a string.
import { layoutGraph } from "../../../../ui/src/graph-layout.ts";
import { connectHost, type ToolResult } from "./host.ts";

type El = {
  className: string;
  textContent: string | null;
  disabled?: boolean;
  open?: boolean;
  append(...c: unknown[]): void;
  replaceChildren(...c: unknown[]): void;
  setAttribute(k: string, v: string): void;
  addEventListener(type: string, fn: () => void): void;
};
type Doc = {
  documentElement: {
    style: { setProperty(k: string, v: string): void };
    setAttribute(k: string, v: string): void;
  };
  body: El;
  createElement(tag: string): El;
};
type Win = Parameters<typeof connectHost>[0];

/** The page's clock, injected so tests can drive it. */
export type Timers = {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
};

const POLL_MS = 5_000;
/** How often the page reads the dashboard itself, and how long it waits for one answer. */
const LIVE_POLL_MS = 2_000;
const LIVE_TIMEOUT_MS = 5_000;
/** The only origins the token may be sent to: the daemon's dashboard, on this machine. */
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
/** A host that never answers a tools/call must not wedge Refresh. */
const CALL_TIMEOUT_MS = 20_000;
/** Run statuses after which nothing changes by itself: no more polling. */
const FINAL = new Set(["staged", "finished", "failed", "cancelled"]);

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : undefined;
const str = (v: unknown): v is string => typeof v === "string";
const recs = (v: unknown): Rec[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out: Rec[] = [];
  for (const x of v) {
    const r = rec(x);
    if (!r) return undefined;
    out.push(r);
  }
  return out;
};

type Gate = { gate: string; verdict: string; reason: string; evidence: string[] };
type Attempt = {
  unit_id: string;
  attempt: number;
  status: string;
  model?: string;
  outcome?: string;
  duration_ms?: number;
  gates: Gate[];
};
type PlanUnit = { id: string; title: string; kind: string; project: string; depends_on: string[] };
type Graph = { units: PlanUnit[]; attempts: Attempt[]; pauses: string[] };
type Usage = {
  provider: string;
  model: string;
  input?: number;
  output?: number;
  cache_read?: number;
};
type One = {
  kind: "one";
  run_id: string;
  status: string;
  plan_approved: boolean;
  units: { unit_id: string; status: string; attempts: number }[];
  attempts: Attempt[];
  usage: Usage[];
  prs: [string, string][];
  stack_on?: { run_id: string; status: string };
  stale?: string;
  graph?: Graph;
};
type Row = {
  run_id: string;
  status: string;
  updated_at: string;
  needs_you?: string;
  owner_node?: string;
};
export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
type Live = { origin: string; token: string };
type Listing = { kind: "list"; runs: Row[] };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(str) : []);

function asAttempt(r: Rec): Attempt | undefined {
  if (!str(r.unit_id) || typeof r.attempt !== "number" || !str(r.status)) return undefined;
  return {
    unit_id: r.unit_id,
    attempt: r.attempt,
    status: r.status,
    ...(str(r.model) ? { model: r.model } : {}),
    ...(str(r.outcome) ? { outcome: r.outcome } : {}),
    ...(typeof r.duration_ms === "number" ? { duration_ms: r.duration_ms } : {}),
    gates: (recs(r.gates) ?? [])
      .filter((g) => str(g.gate) && str(g.verdict))
      .map((g) => ({
        gate: g.gate as string,
        verdict: g.verdict as string,
        reason: str(g.reason) ? g.reason : "",
        evidence: strings(g.evidence),
      })),
  };
}

function asGraph(v: unknown): Graph | undefined {
  const g = rec(v);
  const units = recs(g?.units);
  const attempts = recs(g?.attempts);
  if (!g || !units || !attempts) return undefined;
  const planUnits: PlanUnit[] = [];
  for (const u of units) {
    if (!str(u.id) || !str(u.title)) return undefined;
    planUnits.push({
      id: u.id,
      title: u.title,
      kind: str(u.kind) ? u.kind : "",
      project: str(u.project) ? u.project : "",
      depends_on: strings(u.depends_on),
    });
  }
  return {
    units: planUnits,
    attempts: attempts.map(asAttempt).filter((a): a is Attempt => a !== undefined),
    pauses: strings(g.pauses),
  };
}

/** The shapes of StatusOne and StatusList, checked by hand: the page is not bundled with zod. */
function asView(v: unknown): One | Listing | undefined {
  const s = rec(v);
  if (!s) return undefined;
  if (s.runs !== undefined) {
    const rows = recs(s.runs);
    if (!rows?.every((r) => str(r.run_id) && str(r.status))) return undefined;
    return {
      kind: "list",
      runs: rows.map((r) => ({
        run_id: r.run_id as string,
        status: r.status as string,
        updated_at: r.updated_at === undefined ? "" : String(r.updated_at),
        ...(str(r.needs_you) && r.needs_you ? { needs_you: r.needs_you } : {}),
        ...(str(r.owner_node) && r.owner_node ? { owner_node: r.owner_node } : {}),
      })),
    };
  }
  const run = rec(s.run);
  const units = recs(s.units);
  const attempts = recs(s.attempts);
  if (!run || !str(run.run_id) || !str(run.status) || !units || !attempts) return undefined;
  const us = [];
  for (const u of units) {
    if (!str(u.unit_id) || !str(u.status) || typeof u.attempts !== "number") return undefined;
    us.push({ unit_id: u.unit_id, status: u.status, attempts: u.attempts });
  }
  const stack = rec(s.stack_on);
  const graph = asGraph(s.graph);
  return {
    kind: "one",
    run_id: run.run_id,
    status: run.status,
    plan_approved: s.plan_approved === true,
    units: us,
    attempts: attempts.map(asAttempt).filter((a): a is Attempt => a !== undefined),
    usage: (recs(s.usage) ?? [])
      .filter((u) => str(u.model))
      .map((u) => ({
        provider: str(u.provider) ? u.provider : "",
        model: u.model as string,
        ...(typeof u.input === "number" ? { input: u.input } : {}),
        ...(typeof u.output === "number" ? { output: u.output } : {}),
        ...(typeof u.cache_read === "number" ? { cache_read: u.cache_read } : {}),
      })),
    prs: Object.entries(rec(s.prs) ?? {}).filter((e): e is [string, string] => str(e[1])),
    ...(stack && str(stack.run_id) && str(stack.status)
      ? { stack_on: { run_id: stack.run_id, status: stack.status } }
      : {}),
    ...(str(s.stale) && s.stale ? { stale: s.stale } : {}),
    ...(graph ? { graph } : {}),
  };
}

type Need = { text: string; cmd?: string };

/** What the run waits on the user for, with the command to go on; mirrors attentionLine (watch.ts). */
function needOf(o: One): Need | undefined {
  const id = o.run_id;
  if (o.status === "planned" && !o.plan_approved)
    return {
      text: "The plan is ready and waits for your approval.",
      cmd: `heph approve plan ${id}`,
    };
  if (o.status === "escalated")
    return { text: "The planner escalated.", cmd: `heph explain ${id}` };
  if (o.status === "paused" && o.graph?.pauses.at(-1) === "user") {
    const stuck = o.units.findLast((u) => u.status === "escalated" || u.status === "needs_input");
    return {
      text: "A unit is stuck and waits for your decision.",
      cmd: `heph explain ${id}${stuck ? ` ${stuck.unit_id}` : ""}`,
    };
  }
  if (o.status === "staged") {
    const p = o.stack_on;
    if (p && !["built", "staged", "finished"].includes(p.status))
      return { text: `Stacked on ${p.run_id} (${p.status}): rebuild ${id}.` };
    if (p && ["built", "staged"].includes(p.status))
      return {
        text: `Staged, waiting for ${p.run_id} to land first.`,
        cmd: `heph approve merge ${p.run_id}`,
      };
    return { text: "Staged: review it, then merge.", cmd: `heph approve merge ${id}` };
  }
  return undefined;
}

/** The same, from a list row (it carries no plan_approved or events, so only the unambiguous cases). */
function needOfRow(r: Row): Need | undefined {
  if (r.needs_you) {
    // The daemon's line ends with the command: "<why>: heph approve plan r2".
    const i = r.needs_you.lastIndexOf("heph ");
    if (i < 0) return { text: r.needs_you };
    const why = r.needs_you.slice(0, i).replace(/[:;,\s]+$/, "");
    return { text: why || r.needs_you, cmd: r.needs_you.slice(i) };
  }
  if (r.status === "escalated")
    return { text: "The planner escalated.", cmd: `heph explain ${r.run_id}` };
  if (r.status === "staged")
    return { text: "Staged: review it, then merge.", cmd: `heph approve merge ${r.run_id}` };
  return undefined;
}

const runTone = (s: string) =>
  s === "finished" || s === "staged"
    ? "ok"
    : s === "failed"
      ? "bad"
      : s === "running"
        ? "run"
        : "wait";
const unitTone = (s: string) =>
  s === "accepted"
    ? "ok"
    : s === "escalated" || s === "needs_input"
      ? "bad"
      : s === "running"
        ? "run"
        : "";
const gateTone = (v: string) => (v === "pass" ? "ok" : v === "fail" ? "bad" : "");

export function mountRun(win: Win, doc: Doc, timers: Timers, deps: { fetch?: Fetch } = {}): void {
  const el = (tag: string, cls: string, text?: string): El => {
    const e = doc.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const section = (title: string, ...items: El[]) => {
    const s = el("section", "block");
    s.append(el("h2", "h", title), ...items);
    return s;
  };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

  let host: ReturnType<typeof connectHost> | undefined;
  let view: One | Listing | undefined;
  let fallback = "";
  let lastKey = "";
  let error: string | undefined;
  let busy = false;
  let seq = 0;
  let poll: unknown;
  let pollKind: "direct" | "host" | undefined;
  /** Where the page may read the dashboard, from the last pushed result's _meta. */
  let live: Live | undefined;
  /** A direct read failed: the host's path (if any) serves until a new pushed result says live again. */
  let directBroken = false;
  let directBusy = false;
  /** A run chosen from the list, and the list to go back to. */
  let selected: string | undefined;
  let back: Listing | undefined;
  const fetchLike: Fetch =
    deps.fetch ?? ((url, init) => (globalThis as unknown as { fetch: Fetch }).fetch(url, init));
  /** Units the user opened; a redraw keeps them open. */
  const opened = new Set<string>();

  const show = (...nodes: El[]) => {
    doc.body.replaceChildren(...nodes);
    host?.reportSize();
  };

  const need = (n: Need): El => {
    const b = el("div", "banner");
    b.append(el("span", "banner-text", n.text));
    if (n.cmd) b.append(" Run ", el("code", "cmd", n.cmd), " in a terminal.");
    return b;
  };

  const refreshButton = (): El | undefined => {
    if (!host?.hasServerTools) return undefined;
    const b = el("button", "refresh", busy ? "Refreshing…" : "Refresh");
    if (busy) b.disabled = true;
    b.addEventListener("click", () => void refresh(true));
    return b;
  };

  const attemptRow = (a: Attempt): El => {
    const row = el("div", "attempt");
    const bits = [`attempt ${a.attempt}`, a.status];
    if (a.model) bits.push(a.model);
    if (a.outcome) bits.push(a.outcome);
    if (a.duration_ms !== undefined) bits.push(`${(a.duration_ms / 1000).toFixed(1)} s`);
    row.append(el("div", "attempt-line", bits.join(" · ")));
    for (const g of a.gates) {
      const gl = el("div", `gate ${gateTone(g.verdict)}`);
      gl.append(
        el("div", "gate-line", `${g.gate}: ${g.verdict}${g.reason ? ` — ${g.reason}` : ""}`),
      );
      if (g.evidence.length) {
        const ul = el("ul", "evidence");
        for (const line of g.evidence.slice(0, 5)) ul.append(el("li", "item", line));
        if (g.evidence.length > 5) ul.append(el("li", "item", `… ${g.evidence.length - 5} more`));
        gl.append(ul);
      }
      row.append(gl);
    }
    return row;
  };

  const renderOne = (o: One): El[] => {
    const head = el("header", "head");
    if (back) {
      const b = el("button", "back", "Back to runs");
      b.addEventListener("click", goBack);
      head.append(b);
    }
    head.append(
      el("span", "ids", `run ${o.run_id}`),
      el("span", `badge ${runTone(o.status)}`, o.status),
    );
    const rb = refreshButton();
    if (rb) head.append(rb);
    const parts: El[] = [head];
    if (error) parts.push(el("p", "error", error));
    const n = needOf(o);
    if (n) parts.push(need(n));
    if (o.stale) parts.push(el("p", "stale", o.stale));
    if (o.stack_on)
      parts.push(el("p", "stack", `stacked on ${o.stack_on.run_id} (${o.stack_on.status})`));

    // Attempts: what status knows, overlaid with the dashboard's richer rows (gates, model, time).
    const byUnit = new Map<string, Map<number, Attempt>>();
    for (const a of [...o.attempts, ...(o.graph?.attempts ?? [])]) {
      const m = byUnit.get(a.unit_id) ?? new Map<number, Attempt>();
      m.set(a.attempt, { ...m.get(a.attempt), ...a });
      byUnit.set(a.unit_id, m);
    }
    const statusOf = new Map(o.units.map((u) => [u.unit_id, u]));
    type Item = {
      id: string;
      title?: string;
      kind?: string;
      deps: string[];
      status: string;
      attempts: number;
    };
    const items: Item[] = [];
    if (o.graph) {
      for (const u of o.graph.units) {
        const s = statusOf.get(u.id);
        items.push({
          id: u.id,
          title: u.title,
          kind: u.kind,
          deps: u.depends_on,
          status: s?.status ?? "pending",
          attempts: s?.attempts ?? 0,
        });
      }
      const inPlan = new Set(o.graph.units.map((u) => u.id));
      for (const u of o.units)
        if (!inPlan.has(u.unit_id))
          items.push({ id: u.unit_id, deps: [], status: u.status, attempts: u.attempts });
    } else
      for (const u of o.units)
        items.push({ id: u.unit_id, deps: [], status: u.status, attempts: u.attempts });

    const card = (it: Item, known: Set<string>): El => {
      const tone = unitTone(it.status);
      const d = el("details", `unit ${tone}`.trim());
      if (tone === "bad" || opened.has(it.id)) {
        d.setAttribute("open", "");
        d.open = true;
      }
      d.addEventListener("toggle", () => {
        if (d.open) opened.add(it.id);
        else opened.delete(it.id);
      });
      const sum = el("summary", "unit-top");
      sum.append(el("span", "unit-id", it.id));
      if (it.title) sum.append(el("span", "unit-title", it.title));
      sum.append(el("span", `status ${tone}`.trim(), it.status));
      d.append(sum);
      const meta = [it.kind, plural(it.attempts, "attempt")].filter(Boolean).join(" · ");
      d.append(el("div", "meta", meta));
      const deps = it.deps.filter((x) => known.has(x));
      if (deps.length) d.append(el("div", "after", `after ${deps.join(", ")}`));
      const as = [...(byUnit.get(it.id)?.values() ?? [])].sort((a, b) => a.attempt - b.attempt);
      if (as.length) for (const a of as) d.append(attemptRow(a));
      else d.append(el("div", "muted", "No attempts yet."));
      return d;
    };

    if (!items.length) parts.push(section("Units", el("p", "muted", "No units yet.")));
    else {
      const known = new Set(items.map((i) => i.id));
      const byId = new Map(items.map((i) => [i.id, i]));
      const box = el("div", o.graph ? "layers" : "ulist");
      if (o.graph) {
        const lay = layoutGraph(items.map((i) => ({ id: i.id, depends_on: i.deps })));
        const cols = new Map<number, El>();
        for (const node of lay.nodes) {
          let col = cols.get(node.layer);
          if (!col) {
            col = el("div", "layer");
            cols.set(node.layer, col);
          }
          const it = byId.get(node.id);
          if (it) col.append(card(it, known));
        }
        box.append(...[...cols.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c));
      } else for (const it of items) box.append(card(it, known));
      parts.push(section("Units", box));
    }

    if (o.usage.length) {
      const t = el("table", "usage");
      const hr = el("tr", "");
      for (const h of ["model", "in", "out", "cache"]) hr.append(el("th", "", h));
      t.append(hr);
      for (const u of o.usage) {
        const r = el("tr", "");
        r.append(
          el("td", "", u.provider ? `${u.provider} / ${u.model}` : u.model),
          el("td", "num", String(u.input ?? 0)),
          el("td", "num", String(u.output ?? 0)),
          el("td", "num", String(u.cache_read ?? 0)),
        );
        t.append(r);
      }
      parts.push(section("Model usage", t));
    }
    if (o.prs.length) {
      const ul = el("ul", "prs");
      for (const [repo, url] of o.prs) {
        const li = el("li", "item");
        li.append(`${repo}: `);
        if (/^https?:\/\//i.test(url)) {
          const a = el("a", "pr", url);
          a.setAttribute("href", url);
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noopener noreferrer");
          li.append(a);
        } else li.append(url);
        ul.append(li);
      }
      parts.push(section("Pull requests", ul));
    }
    return parts;
  };

  const renderList = (l: Listing): El[] => {
    const head = el("header", "head");
    head.append(el("span", "ids", "heph runs"));
    const rb = refreshButton();
    if (rb) head.append(rb);
    const parts: El[] = [head];
    if (error) parts.push(el("p", "error", error));
    if (!l.runs.length) {
      parts.push(el("p", "muted", "No runs."));
      return parts;
    }
    const rows = l.runs.map((r) => ({ r, need: needOfRow(r) }));
    // Runs that need the user first; otherwise the daemon's order.
    rows.sort((a, b) => Number(Boolean(b.need)) - Number(Boolean(a.need)));
    const t = el("table", "runs");
    const hr = el("tr", "");
    for (const h of ["run", "node", "status", "updated", "needs you"]) hr.append(el("th", "", h));
    t.append(hr);
    for (const { r, need: n } of rows) {
      const tr = el("tr", "run-row");
      const status = el("td", "");
      status.append(el("span", `badge ${runTone(r.status)}`, r.status));
      const last = el("td", "");
      if (n) {
        if (n.cmd) last.append(`${n.text} `, el("code", "cmd", n.cmd));
        else last.append(n.text);
      }
      const id = el("td", "run-id");
      if (canSelect()) {
        const b = el("button", "link", r.run_id);
        b.addEventListener("click", () => select(r.run_id));
        id.append(b);
      } else id.textContent = r.run_id;
      tr.append(
        id,
        el("td", "", r.owner_node ?? ""),
        status,
        el("td", "muted", r.updated_at),
        last,
      );
      t.append(tr);
    }
    parts.push(t);
    return parts;
  };

  const draw = () => {
    if (!view) {
      show(el("pre", "fallback", fallback || "No run to show."));
      return;
    }
    show(...(view.kind === "one" ? renderOne(view) : renderList(view)));
  };

  /** What the live poll reads: the list, or one run; nothing once a run is final. */
  const target = (): { run?: string } | undefined => {
    if (view?.kind === "one") return FINAL.has(view.status) ? undefined : { run: view.run_id };
    if (selected !== undefined) return { run: selected };
    return view?.kind === "list" ? {} : undefined;
  };

  const liveOn = () => live !== undefined && !directBroken;
  const canSelect = () => liveOn() || host?.hasServerTools === true;

  const syncPolling = () => {
    const direct = liveOn() && target() !== undefined;
    const viaHost =
      !direct && host?.hasServerTools === true && view?.kind === "one" && !FINAL.has(view.status);
    const kind = direct ? "direct" : viaHost ? "host" : undefined;
    if (kind === pollKind) return;
    if (poll !== undefined) timers.clearInterval(poll);
    poll = undefined;
    pollKind = kind;
    if (kind === "direct") poll = timers.setInterval(() => void directPoll(), LIVE_POLL_MS);
    else if (kind === "host") poll = timers.setInterval(() => void refresh(false), POLL_MS);
  };

  /** One read-only dashboard method, answered with the daemon's data or an error. */
  async function api(method: string, args: unknown[]): Promise<unknown> {
    if (!live) throw new Error("no dashboard to read");
    const r = await fetchLike(`${live.origin}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${live.token}` },
      body: JSON.stringify({ args }),
    });
    if (!r.ok) throw new Error(`the dashboard answered ${r.status}`);
    const j = rec(await r.json());
    if (!j || j.ok !== true)
      throw new Error(
        str(rec(j?.error)?.message) ? String(rec(j?.error)?.message) : "the dashboard refused",
      );
    return j.data;
  }

  /** The same view heph_status gives the widget: status, plus the dashboard's graph for one run. */
  async function readView(run: string | undefined): Promise<unknown> {
    if (run === undefined) return api("status", []);
    const [status, dash] = await Promise.all([
      api("status", [run]),
      api("dashboard", [run]).catch(() => undefined),
    ]);
    const d = rec(dash);
    const units = recs(rec(d?.plan)?.units);
    const g =
      d && units
        ? {
            units,
            attempts: Array.isArray(d.attempts) ? d.attempts : [],
            pauses: strings(d.pauses),
          }
        : undefined;
    return { ...rec(status), ...(g ? { graph: g } : {}) };
  }

  async function directPoll(): Promise<void> {
    const tgt = target();
    if (directBusy || !liveOn() || !tgt) return;
    directBusy = true;
    const mine = seq;
    let timer: unknown;
    try {
      const timeout = new Promise<never>((_, no) => {
        timer = timers.setTimeout(
          () => no(new Error("the dashboard did not answer in time")),
          LIVE_TIMEOUT_MS,
        );
      });
      const data = await Promise.race([readView(tgt.run), timeout]);
      // The host pushed something newer, or the user chose another run, while we waited.
      if (seq !== mine) return;
      if (!take({ structuredContent: data }, false)) throw new Error("unreadable answer");
    } catch (e) {
      // Keep the last view; the host's path (Refresh, polling) serves if it has one.
      directBroken = true;
      fail(`Live updates stopped: ${e instanceof Error ? e.message : String(e)}`);
      syncPolling();
    } finally {
      if (timer !== undefined) timers.clearTimeout(timer);
      directBusy = false;
    }
  }

  /** Reads now, by whichever path works, instead of waiting for the next tick. */
  const kick = () => {
    if (liveOn()) void directPoll();
    else if (host?.hasServerTools) void refresh(false);
  };

  function select(run: string): void {
    if (view?.kind === "list") back = view;
    selected = run;
    view = undefined;
    lastKey = "";
    error = undefined;
    seq++;
    show(el("p", "muted", `Loading ${run}…`));
    syncPolling();
    kick();
  }

  function goBack(): void {
    if (!back) return;
    view = back;
    back = undefined;
    selected = undefined;
    lastKey = "";
    seq++;
    draw();
    syncPolling();
    kick();
  }

  /** Takes a result as the new state; a result with no readable shape keeps the view. */
  const take = (r: ToolResult, pushed: boolean): boolean => {
    if (pushed) {
      // The host's own answer decides where the page may read from; a new one resets a failure.
      const l = rec(rec(rec(r._meta)?.heph)?.live);
      live =
        l && str(l.origin) && str(l.token) && LOOPBACK.test(l.origin)
          ? { origin: l.origin, token: l.token }
          : undefined;
      directBroken = false;
      selected = undefined;
    }
    const v = asView(r.structuredContent);
    if (!v) {
      if (pushed) {
        view = undefined;
        fallback = (r.content ?? [])
          .map((c) => (c.type === "text" ? c.text : undefined))
          .filter(Boolean)
          .join("\n");
        lastKey = "";
        error = undefined;
        draw();
        syncPolling();
      }
      return false;
    }
    seq++;
    const key = JSON.stringify(r.structuredContent);
    const same = key === lastKey && error === undefined;
    if (pushed && v.kind === "list") back = undefined;
    view = v;
    lastKey = key;
    error = undefined;
    if (!same) draw();
    syncPolling();
    return true;
  };

  const fail = (msg: string) => {
    error = msg;
    if (view) draw();
  };

  async function refresh(manual: boolean): Promise<void> {
    if (busy || !host?.hasServerTools) return;
    busy = true;
    const mine = seq;
    if (manual && view) draw();
    let timer: unknown;
    try {
      const run = view?.kind === "one" ? view.run_id : selected;
      const args = run === undefined ? {} : { run };
      const timeout = new Promise<never>((_, no) => {
        timer = timers.setTimeout(
          () => no(new Error("the host did not answer the refresh in time")),
          CALL_TIMEOUT_MS,
        );
      });
      const r = await Promise.race([host.callTool("heph_status", args), timeout]);
      if (seq !== mine) {
        // The host pushed a newer result while we waited: that one stands, whatever this answer was.
      } else if (r.isError) {
        const msg = (r.content ?? [])
          .map((c) => c.text)
          .filter(Boolean)
          .join(" ");
        fail(`Refresh failed: ${msg || "the tool reported an error"}`);
      } else if (!take(r, false)) fail("Refresh failed: unreadable answer from the tool");
    } catch (e) {
      if (seq === mine) fail(`Refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (timer !== undefined) timers.clearTimeout(timer);
      busy = false;
      if (manual && view) draw();
    }
  }

  show(el("p", "muted", "Waiting for the run…"));
  const h = connectHost(win, doc, { name: "heph-run", version: "1" });
  host = h;
  h.onToolResult((r) => {
    take(r, true);
  });
  h.ready.then(
    () => {
      // The refresh control and polling depend on what the host said at initialize.
      if (view) draw();
      syncPolling();
      if (selected !== undefined) kick();
    },
    () => show(el("p", "muted", "This page needs a host that supports MCP Apps.")),
  );
}
