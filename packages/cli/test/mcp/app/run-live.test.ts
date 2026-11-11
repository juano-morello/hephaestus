import { describe, expect, test } from "bun:test";
import { mountRun, type Timers } from "../../../src/mcp/app/run.ts";
import { type FakeEl, fakeHost } from "./fake-dom.ts";

/** Manual timers: nothing fires until advance(). */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const items = new Map<number, { at: number; every?: number; fn: () => void }>();
  const timers: Timers = {
    setInterval: (fn, ms) => {
      items.set(next, { at: now + ms, every: ms, fn });
      return next++;
    },
    clearInterval: (h) => void items.delete(h as number),
    setTimeout: (fn, ms) => {
      items.set(next, { at: now + ms, fn });
      return next++;
    },
    clearTimeout: (h) => void items.delete(h as number),
  };
  return {
    timers,
    intervals: () => [...items.values()].filter((i) => i.every !== undefined).length,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...items.entries()]
          .filter(([, i]) => i.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, it] = due;
        now = it.at;
        if (it.every !== undefined) it.at += it.every;
        else items.delete(id);
        it.fn();
        await new Promise((r) => setTimeout(r, 0));
      }
      now = end;
    },
  };
}

const ORIGIN = "http://127.0.0.1:7878";
const TOKEN = "k".repeat(43);
const live = { heph: { live: { origin: ORIGIN, token: TOKEN } } };

const run = (status: string, id = "r1") => ({ run_id: id, status });
const one = (status = "running", id = "r1") => ({
  run: run(status, id),
  plan_approved: true,
  units: [{ unit_id: "u1", status: status === "running" ? "running" : "accepted", attempts: 1 }],
  attempts: [],
  usage: [],
});
const dash = (status = "running", id = "r1") => ({
  schema: 1,
  run: run(status, id),
  plan_approved: true,
  plan: {
    units: [
      { id: "u1", title: "Write the parser", kind: "implement", project: "app", depends_on: [] },
    ],
  },
  units: [{ unit_id: "u1", status: "running", attempts: 1, in_plan: true }],
  attempts: [],
  pauses: [],
  usage: [],
});

type Call = { url: string; method: string; auth: string | null; args: unknown };
/** A fetch that records every call and answers from `answer(method, args)`. */
function fakeFetch(answer: (method: string, args: unknown[]) => unknown | Error | number) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const method = url.slice(`${ORIGIN}/api/`.length);
    const args = (JSON.parse(init.body) as { args: unknown[] }).args;
    calls.push({ url, method, auth: init.headers.authorization ?? null, args });
    const a = answer(method, args);
    if (a instanceof Error) throw a;
    if (typeof a === "number") return { ok: false, status: a, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ ok: true, data: a }) };
  };
  return { fetch, calls };
}

async function mount(
  sc: unknown,
  fetchLike: ReturnType<typeof fakeFetch>,
  o: { serverTools?: boolean; meta?: unknown } = {},
) {
  const f = fakeHost(o.serverTools ? { hostCapabilities: { serverTools: {} } } : {});
  const t = fakeTimers();
  mountRun(f.win as never, f.doc as never, t.timers, { fetch: fetchLike.fetch as never });
  await f.tick();
  f.notify("ui/notifications/tool-input", { arguments: {} });
  f.notify("ui/notifications/tool-result", {
    content: [{ type: "text", text: "t" }],
    structuredContent: sc,
    ...(o.meta === undefined ? { _meta: live } : { _meta: o.meta }),
  });
  return { f, t };
}
const text = (f: { body: FakeEl }) => f.body.textContent;
const toolCalls = (f: ReturnType<typeof fakeHost>) =>
  f.sent.filter((m) => m.method === "tools/call");
const refreshOf = (f: { body: FakeEl }) =>
  f.body.find((e) => e.tag === "button" && e.className === "refresh");

describe("run widget: direct polling of the dashboard", () => {
  test("polls status and dashboard every 2 s with the token, with no serverTools, and redraws", async () => {
    const net = fakeFetch((m) => (m === "status" ? one("running") : dash("running")));
    const { f, t } = await mount(one("running"), net);
    expect(net.calls).toEqual([]);
    expect(t.intervals()).toBe(1);
    await t.advance(1999);
    expect(net.calls).toEqual([]);
    await t.advance(1);
    expect(net.calls.map((c) => c.method).sort()).toEqual(["dashboard", "status"]);
    for (const c of net.calls) {
      expect(c.url).toStartWith(`${ORIGIN}/api/`);
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
      expect(c.args).toEqual(["r1"]);
    }
    // The dashboard's plan reached the graph.
    expect(text(f)).toContain("Write the parser");
    await t.advance(2000);
    expect(net.calls).toHaveLength(4);
    expect(toolCalls(f)).toEqual([]);
  });

  test("stops polling once the run is staged, finished, failed or cancelled", async () => {
    for (const final of ["staged", "finished", "failed", "cancelled"]) {
      let n = 0;
      const net = fakeFetch((m) => {
        n++;
        return m === "status" ? one(final) : dash(final);
      });
      const { f, t } = await mount(one("running"), net);
      await t.advance(2000);
      expect(f.body.byClass("badge")[0]?.textContent).toBe(final);
      const seen = n;
      expect(t.intervals()).toBe(0);
      await t.advance(20_000);
      expect(n).toBe(seen);
    }
  });

  test("polls directly with no live _meta only through the host, as before", async () => {
    const net = fakeFetch(() => one());
    const { t } = await mount(one("running"), net, { meta: {} });
    await t.advance(10_000);
    expect(net.calls).toEqual([]);
    expect(t.intervals()).toBe(0);
  });
});

describe("run widget: when the direct poll fails", () => {
  for (const [label, answer] of [
    ["a rejected fetch", () => new Error("connection refused")],
    ["a 401", () => 401],
  ] as const) {
    test(`${label} keeps the last view, notes the error and stops polling directly`, async () => {
      const net = fakeFetch(answer);
      const { f, t } = await mount(one("running"), net);
      await t.advance(2000);
      const afterFirst = net.calls.length;
      expect(afterFirst).toBeGreaterThan(0);
      expect(text(f)).toContain("u1");
      expect(f.body.byClass("error")[0]?.textContent).toContain("Live updates");
      expect(f.body.byClass("badge")[0]?.textContent).toBe("running");
      await t.advance(30_000);
      expect(net.calls).toHaveLength(afterFirst);
      expect(text(f)).toContain("u1");
    });
  }

  test("with serverTools the host path takes over, at its own pace", async () => {
    const net = fakeFetch(() => new Error("blocked by the host"));
    const { f, t } = await mount(one("running"), net, { serverTools: true });
    await f.tick();
    await t.advance(2000);
    const afterFirst = net.calls.length;
    expect(toolCalls(f)).toEqual([]);
    await t.advance(5000);
    expect(toolCalls(f).length).toBeGreaterThan(0);
    expect(toolCalls(f)[0]?.params).toMatchObject({
      name: "heph_status",
      arguments: { run: "r1" },
    });
    expect(net.calls).toHaveLength(afterFirst);
    expect(refreshOf(f)).toBeDefined();
  });

  test("a newer pushed result with live _meta resumes direct polling", async () => {
    let fail = true;
    const net = fakeFetch((m) =>
      fail ? new Error("down") : m === "status" ? one("running") : dash("running"),
    );
    const { f, t } = await mount(one("running"), net);
    await t.advance(2000);
    const stopped = net.calls.length;
    await t.advance(10_000);
    expect(net.calls).toHaveLength(stopped);
    fail = false;
    f.notify("ui/notifications/tool-result", {
      content: [{ type: "text", text: "t" }],
      structuredContent: one("running"),
      _meta: live,
    });
    await t.advance(2000);
    expect(net.calls.length).toBeGreaterThan(stopped);
    expect(f.body.byClass("error")).toEqual([]);
  });
});

describe("run widget: the list of runs", () => {
  const rows = [
    { run_id: "r1", status: "running", updated_at: "10:00", owner_node: "mbp" },
    { run_id: "r2", status: "escalated", updated_at: "09:00", owner_node: "denver" },
  ];
  const listAnswer = (m: string, args: unknown[]) => {
    if (m === "status") return args.length ? one("running", String(args[0])) : { runs: rows };
    return dash("running", String(args[0]));
  };

  test("polls every 2 s and shows each run's owner node and what it needs", async () => {
    const net = fakeFetch(listAnswer);
    const { f, t } = await mount({ runs: [rows[0]] }, net);
    expect(text(f)).not.toContain("denver");
    await t.advance(2000);
    expect(net.calls).toEqual([
      { url: `${ORIGIN}/api/status`, method: "status", auth: `Bearer ${TOKEN}`, args: [] },
    ]);
    const t2 = text(f);
    expect(t2).toContain("denver");
    expect(t2).toContain("mbp");
    expect(t2).toContain("The planner escalated.");
    expect(t2).toContain("heph explain r2");
    await t.advance(2000);
    expect(net.calls).toHaveLength(2);
  });

  test("selecting a row shows that run's detail with a way back to the list", async () => {
    const net = fakeFetch(listAnswer);
    const { f, t } = await mount({ runs: rows }, net);
    await t.advance(2000);
    const pick = f.body.find((e) => e.tag === "button" && e.textContent === "r2")[0];
    expect(pick).toBeDefined();
    pick?.click();
    await t.advance(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(f.body.byClass("ids")[0]?.textContent).toContain("r2");
    const back = f.body.find((e) => e.tag === "button" && e.textContent === "Back to runs")[0];
    expect(back).toBeDefined();
    // While a run is shown, the polling follows that run.
    net.calls.length = 0;
    await t.advance(2000);
    expect(net.calls.every((c) => (c.args as unknown[])[0] === "r2")).toBe(true);
    back?.click();
    await t.advance(0);
    // Going back reads the list at once; let that read finish.
    await new Promise((r) => setTimeout(r, 0));
    expect(f.body.byClass("ids")[0]?.textContent).toContain("heph runs");
    net.calls.length = 0;
    await t.advance(2000);
    expect(net.calls.map((c) => c.args)).toEqual([[]]);
  });
});
