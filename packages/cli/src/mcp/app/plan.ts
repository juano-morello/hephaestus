// The plan review widget: renders heph_plan_show's structuredContent. Read-only by design (approving
// is the user's `heph approve plan`, outside the chat), so there are no controls. Everything model-
// written goes in through textContent; nothing here builds markup from a string.
import { connectHost, type ToolResult } from "./host.ts";

type El = {
  className: string;
  textContent: string | null;
  append(...c: unknown[]): void;
  replaceChildren(...c: unknown[]): void;
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

type Task = { id: string; title: string; scope: string[]; covers: string[] } & Record<
  string,
  unknown
>;
type Plan = {
  run_id: string;
  plan_id: string;
  approved: boolean;
  order: string[];
  tasks: Task[];
  risks: string[];
};

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

/** The shape of PlanShow, checked by hand: the page is not bundled with zod. */
function asPlan(v: unknown): Plan | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const p = v as Record<string, unknown>;
  if (
    typeof p.run_id !== "string" ||
    typeof p.plan_id !== "string" ||
    typeof p.approved !== "boolean"
  )
    return undefined;
  if (!isStrings(p.order) || !isStrings(p.risks) || !Array.isArray(p.tasks)) return undefined;
  const tasks: Task[] = [];
  for (const t of p.tasks) {
    const o = t as Record<string, unknown> | null;
    if (
      !o ||
      typeof o.id !== "string" ||
      typeof o.title !== "string" ||
      !isStrings(o.scope) ||
      !isStrings(o.covers)
    )
      return undefined;
    tasks.push(o as Task);
  }
  return {
    run_id: p.run_id,
    plan_id: p.plan_id,
    approved: p.approved,
    order: p.order,
    tasks,
    risks: p.risks,
  };
}

/** Tasks in build order; any task the order does not name follows, in plan order. */
function ordered(p: Plan): Task[] {
  const byId = new Map(p.tasks.map((t) => [t.id, t]));
  const out: Task[] = [];
  const seen = new Set<string>();
  for (const id of p.order) {
    const t = byId.get(id);
    if (t && !seen.has(id)) {
      seen.add(id);
      out.push(t);
    }
  }
  for (const t of p.tasks) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

export function mountPlan(win: Win, doc: Doc): void {
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
  const list = (cls: string, items: string[]) => {
    const ul = el("ul", cls);
    for (const i of items) ul.append(el("li", "item", i));
    return ul;
  };

  let host: ReturnType<typeof connectHost> | undefined;
  const show = (...nodes: El[]) => {
    doc.body.replaceChildren(...nodes);
    host?.reportSize();
  };
  show(el("p", "muted", "Waiting for the plan…"));

  const render = (r: ToolResult) => {
    const plan = asPlan(r.structuredContent);
    if (!plan) {
      const text = (r.content ?? [])
        .map((c) => (c.type === "text" ? c.text : undefined))
        .filter(Boolean)
        .join("\n");
      show(el("pre", "fallback", text || "No plan to show."));
      return;
    }
    const head = el("header", "head");
    head.append(
      el("span", "ids", `plan ${plan.plan_id} · run ${plan.run_id}`),
      el(
        "span",
        plan.approved ? "badge ok" : "badge wait",
        plan.approved ? "approved" : "waiting for your approval",
      ),
    );

    const tasks = ordered(plan);
    const flow = el("ol", "flow");
    tasks.forEach((t, i) => {
      const card = el("li", "task");
      const top = el("div", "task-top");
      top.append(
        el("span", "task-n", String(i + 1)),
        el("span", "task-id", t.id),
        el("span", "task-title", t.title),
      );
      card.append(top);
      const meta = [t.project, t.lane, t.complexity]
        .filter((s): s is string => typeof s === "string" && s !== "")
        .join(" · ");
      if (meta) card.append(el("div", "meta", meta));
      if (t.scope.length) card.append(el("div", "label", "Files"), list("scope", t.scope));
      if (t.covers.length)
        card.append(el("div", "label", "Acceptance criteria"), list("covers", t.covers));
      flow.append(card);
    });

    const parts: El[] = [head];
    parts.push(
      section(
        "Tasks in build order",
        tasks.length ? flow : el("p", "muted", "No tasks in this plan."),
      ),
    );
    if (plan.risks.length) parts.push(section("Risks", list("risks", plan.risks)));
    const note = el("p", "note");
    if (plan.approved)
      note.append("This plan is approved. Approval happens outside the chat (heph approve plan).");
    else
      note.append(
        "Approval happens outside the chat: run ",
        el("code", "cmd", `heph approve plan ${plan.run_id}`),
        " in a terminal.",
      );
    parts.push(note);
    show(...parts);
  };

  const h = connectHost(win, doc, { name: "heph-plan", version: "1" });
  host = h;
  h.onToolResult(render);
  h.ready.catch(() => show(el("p", "muted", "This page needs a host that supports MCP Apps.")));
}
