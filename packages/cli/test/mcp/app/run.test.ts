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
    active: () => [...items.values()].filter((i) => i.every !== undefined).length,
    /** Moves the clock; fires what is due, in order. */
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

const one = (over: Record<string, unknown> = {}) => ({
  run: { run_id: "r1", status: "running" },
  plan_approved: true,
  units: [
    { unit_id: "u1", status: "accepted", attempts: 1 },
    { unit_id: "u2", status: "running", attempts: 2 },
  ],
  attempts: [
    { unit_id: "u1", attempt: 1, status: "finished" },
    { unit_id: "u2", attempt: 1, status: "finished" },
    { unit_id: "u2", attempt: 2, status: "running" },
  ],
  usage: [{ provider: "anthropic", model: "opus", input: 10, output: 5, cache_read: 2 }],
  ...over,
});
const graph = (over: Record<string, unknown> = {}) => ({
  units: [
    { id: "u1", title: "Write the parser", kind: "feature", project: "app", depends_on: [] },
    { id: "u2", title: "Wire the CLI", kind: "feature", project: "app", depends_on: ["u1"] },
  ],
  attempts: [
    {
      unit_id: "u1",
      attempt: 1,
      status: "finished",
      model: "opus",
      outcome: "returned",
      duration_ms: 1500,
      gates: [{ gate: "test", verdict: "pass", reason: "all green", evidence: [] }],
    },
    {
      unit_id: "u2",
      attempt: 1,
      status: "finished",
      model: "opus",
      outcome: "returned",
      gates: [
        { gate: "typecheck", verdict: "fail", reason: "TS2322 in cli.ts", evidence: ["cli.ts:3"] },
      ],
    },
    { unit_id: "u2", attempt: 2, status: "running", gates: [] },
  ],
  pauses: [],
  ...over,
});
const list = (runs: Record<string, unknown>[]) => ({ runs });

type Opts = { hostOpts?: Record<string, unknown>; text?: string };
async function mount(sc?: unknown, o: Opts = {}) {
  const f = fakeHost(o.hostOpts);
  const t = fakeTimers();
  mountRun(f.win as never, f.doc as never, t.timers);
  await f.tick();
  f.notify("ui/notifications/tool-input", { arguments: {} });
  if (sc !== undefined || o.text !== undefined)
    f.notify("ui/notifications/tool-result", {
      content: [{ type: "text", text: o.text ?? "plain text result" }],
      ...(sc === undefined ? {} : { structuredContent: sc }),
    });
  return { f, t };
}
const text = (f: { body: FakeEl }) => f.body.textContent;
const buttons = (f: { body: FakeEl }) => f.body.find((e) => e.tag === "button");
const withTools = { hostOpts: { hostCapabilities: { serverTools: {} } } };
const result = (sc: unknown, extra: Record<string, unknown> = {}) => ({
  content: [{ type: "text", text: "t" }],
  structuredContent: sc,
  ...extra,
});
/** Answers the page's next tools/call. */
function answerNext(f: ReturnType<typeof fakeHost>, res?: unknown, error?: string) {
  const req = f.sent.filter((m) => m.method === "tools/call").at(-1);
  f.deliver({
    jsonrpc: "2.0",
    id: req?.id,
    ...(error ? { error: { code: -32603, message: error } } : { result: res }),
  });
}
const calls = (f: ReturnType<typeof fakeHost>) => f.sent.filter((m) => m.method === "tools/call");

describe("run widget: one run", () => {
  test("header, badge, unit cards with title, kind, status and attempt count", async () => {
    const { f } = await mount({ ...one(), graph: graph() });
    expect(f.body.byClass("ids")[0]?.textContent).toContain("r1");
    expect(f.body.byClass("badge")[0]?.textContent).toBe("running");
    const cards = f.body.byClass("unit");
    expect(cards.map((c) => c.byClass("unit-id")[0]?.textContent)).toEqual(["u1", "u2"]);
    const u2 = cards[1]?.textContent ?? "";
    expect(u2).toContain("Wire the CLI");
    expect(u2).toContain("feature");
    expect(u2).toContain("running");
    expect(u2).toContain("2 attempts");
    expect(cards[0]?.textContent).toContain("1 attempt");
    expect(cards[0]?.textContent).not.toContain("1 attempts");
  });

  test("units are laid out in dependency layers and name what they wait for", async () => {
    const { f } = await mount({ ...one(), graph: graph() });
    const layers = f.body.byClass("layer");
    expect(layers).toHaveLength(2);
    expect(layers[0]?.byClass("unit-id")[0]?.textContent).toBe("u1");
    expect(layers[1]?.byClass("unit-id")[0]?.textContent).toBe("u2");
    expect(layers[1]?.textContent).toContain("after u1");
    expect(layers[0]?.textContent).not.toContain("after");
  });

  test("a card lists its attempts, with gate results where the graph carries them", async () => {
    const { f } = await mount({ ...one(), graph: graph() });
    const u2 = f.body.byClass("unit")[1];
    const attempts = u2?.byClass("attempt") ?? [];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.textContent).toContain("attempt 1");
    expect(attempts[0]?.textContent).toContain("opus");
    const gate = attempts[0]?.byClass("gate")[0];
    expect(gate?.textContent).toContain("typecheck");
    expect(gate?.textContent).toContain("fail");
    expect(gate?.textContent).toContain("TS2322 in cli.ts");
    expect(gate?.textContent).toContain("cli.ts:3");
    expect(f.body.byClass("unit")[0]?.byClass("attempt")[0]?.textContent).toContain("1.5 s");
    // The card is a native <details>: expanding needs no script.
    expect(u2?.tag).toBe("details");
    expect(u2?.find((e) => e.tag === "summary")).toHaveLength(1);
  });

  test("a failed attempt marks its card and opens it", async () => {
    const sc = one({
      units: [{ unit_id: "u1", status: "escalated", attempts: 1 }],
      attempts: [{ unit_id: "u1", attempt: 1, status: "finished" }],
    });
    const { f } = await mount({ ...sc, graph: graph({ attempts: [], units: [graph().units[0]] }) });
    const card = f.body.byClass("unit")[0];
    expect(card?.className.split(" ")).toContain("bad");
    expect(card?.attrs.open).toBeDefined();
  });

  test("without a graph it is a plain unit list from status, attempts from status", async () => {
    const { f } = await mount(one());
    const cards = f.body.byClass("unit");
    expect(cards.map((c) => c.byClass("unit-id")[0]?.textContent)).toEqual(["u1", "u2"]);
    expect(f.body.byClass("layer")).toHaveLength(0);
    expect(cards[1]?.byClass("attempt")).toHaveLength(2);
    expect(text(f)).not.toContain("after");
  });

  test("plan units that have not started show as pending; dropped units still show", async () => {
    const sc = one({ units: [{ unit_id: "old", status: "accepted", attempts: 1 }], attempts: [] });
    const { f } = await mount({ ...sc, graph: graph() });
    const ids = f.body.byClass("unit").map((c) => c.byClass("unit-id")[0]?.textContent);
    expect(ids.sort()).toEqual(["old", "u1", "u2"]);
    const u1 = f.body.byClass("unit").find((c) => c.byClass("unit-id")[0]?.textContent === "u1");
    expect(u1?.textContent).toContain("pending");
    expect(u1?.textContent).toContain("0 attempts");
  });

  test("an empty run (no units) says so", async () => {
    const { f } = await mount(one({ units: [], attempts: [], usage: [] }));
    expect(f.body.byClass("unit")).toHaveLength(0);
    expect(text(f)).toContain("No units yet");
    expect(f.body.byClass("usage")).toHaveLength(0);
  });

  test("many units render one card each", async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `u${i}`);
    const sc = one({
      units: ids.map((id) => ({ unit_id: id, status: "pending", attempts: 0 })),
      attempts: [],
    });
    const g = graph({
      units: ids.map((id, i) => ({
        id,
        title: `T ${id}`,
        kind: "feature",
        project: "app",
        depends_on: i ? [`u${i - 1}`] : [],
      })),
    });
    const { f } = await mount({ ...sc, graph: g });
    expect(f.body.byClass("unit")).toHaveLength(80);
  });

  test("usage table, pull request links, stack note and stale note", async () => {
    const { f } = await mount({
      ...one({
        prs: { app: "https://github.com/o/app/pull/7", odd: "javascript:alert(1)" },
        stack_on: { run_id: "r0", status: "staged" },
        stale: "possibly stale: laptop is unreachable",
      }),
      graph: graph(),
    });
    const usage = f.body.byClass("usage")[0];
    expect(usage?.tag).toBe("table");
    expect(usage?.textContent).toContain("opus");
    expect(usage?.textContent).toContain("10");
    const links = f.body.find((e) => e.tag === "a");
    expect(links).toHaveLength(1);
    expect(links[0]?.attrs.href).toBe("https://github.com/o/app/pull/7");
    expect(text(f)).toContain("javascript:alert(1)");
    expect(text(f)).toContain("stacked on r0 (staged)");
    expect(f.body.byClass("stale")[0]?.textContent).toContain("laptop is unreachable");
  });

  test("a stale run without extras shows neither stack nor links", async () => {
    const { f } = await mount(one());
    expect(f.body.byClass("stale")).toHaveLength(0);
    expect(text(f)).not.toContain("stacked on");
    expect(f.body.find((e) => e.tag === "a")).toHaveLength(0);
  });

  test("waiting banners: plan approval, planner escalated, decision, staged, waiting for parent", async () => {
    const banner = async (sc: unknown) => (await mount(sc)).f.body.byClass("banner")[0];
    const plan = await banner(
      one({ run: { run_id: "r1", status: "planned" }, plan_approved: false, units: [] }),
    );
    expect(plan?.textContent).toContain("approval");
    expect(plan?.byClass("cmd")[0]?.textContent).toBe("heph approve plan r1");

    const esc = await banner(one({ run: { run_id: "r1", status: "escalated" } }));
    expect(esc?.byClass("cmd")[0]?.textContent).toBe("heph explain r1");

    const paused = await banner({
      ...one({
        run: { run_id: "r1", status: "paused" },
        units: [{ unit_id: "u2", status: "escalated", attempts: 3 }],
      }),
      graph: graph({ pauses: ["rate limited", "user"] }),
    });
    expect(paused?.byClass("cmd")[0]?.textContent).toBe("heph explain r1 u2");

    const staged = await banner(one({ run: { run_id: "r1", status: "staged" } }));
    expect(staged?.byClass("cmd")[0]?.textContent).toBe("heph approve merge r1");

    const parent = await banner(
      one({
        run: { run_id: "r2", status: "staged" },
        stack_on: { run_id: "r1", status: "staged" },
      }),
    );
    expect(parent?.textContent).toContain("r1");
    expect(parent?.byClass("cmd")[0]?.textContent).toBe("heph approve merge r1");

    const blocked = await banner(
      one({
        run: { run_id: "r2", status: "staged" },
        stack_on: { run_id: "r1", status: "failed" },
      }),
    );
    expect(blocked?.textContent).toContain("rebuild r2");
  });

  test("no banner while it builds, once finished or failed, or after a rate-limit pause", async () => {
    for (const status of ["running", "finished", "failed", "built", "created"]) {
      const { f } = await mount(one({ run: { run_id: "r1", status } }));
      expect(f.body.byClass("banner")).toHaveLength(0);
    }
    const { f } = await mount({
      ...one({ run: { run_id: "r1", status: "paused" } }),
      graph: graph({ pauses: ["rate limited until 12:00"] }),
    });
    expect(f.body.byClass("banner")).toHaveLength(0);
  });

  test("hostile strings stay inert text", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    const { f } = await mount({
      ...one({
        run: { run_id: evil, status: "running" },
        units: [{ unit_id: evil, status: "</script><b>x</b>", attempts: 1 }],
        attempts: [{ unit_id: evil, attempt: 1, status: evil }],
        usage: [{ provider: evil, model: "</script><script>alert(2)</script>" }],
        prs: { [evil]: evil },
        stack_on: { run_id: evil, status: evil },
        stale: evil,
      }),
      graph: graph({
        units: [
          { id: evil, title: "</script><b>t</b>", kind: evil, project: evil, depends_on: [] },
        ],
        attempts: [
          {
            unit_id: evil,
            attempt: 1,
            status: evil,
            model: evil,
            gates: [{ gate: evil, verdict: evil, reason: evil, evidence: [evil] }],
          },
        ],
      }),
    });
    expect(f.body.find((e) => ["img", "script", "b"].includes(e.tag))).toEqual([]);
    expect(text(f)).toContain(evil);
    expect(text(f)).toContain("</script><b>t</b>");
    expect(f.body.find((e) => Object.keys(e.attrs).some((k) => k.startsWith("on")))).toEqual([]);
  });

  test("hostile text in the fallback path is inert too", async () => {
    const { f } = await mount(undefined, { text: "<img src=x onerror=alert(1)>" });
    expect(f.body.find((e) => e.tag === "img")).toEqual([]);
    expect(text(f)).toContain("<img src=x onerror=alert(1)>");
  });

  test("malformed structuredContent falls back to the text", async () => {
    for (const sc of [{ nope: 1 }, "s", { run: { run_id: 1 }, units: [] }, { runs: "x" }]) {
      const { f } = await mount(sc, { text: "run r1: running" });
      expect(text(f)).toContain("run r1: running");
      expect(f.body.byClass("unit")).toHaveLength(0);
    }
  });

  test("reports its size and applies host colours", async () => {
    const { f } = await mount(one(), {
      hostOpts: { variables: { "--color-text-primary": "#abc" } },
    });
    expect(f.sent.some((m) => m.method === "ui/notifications/size-changed")).toBe(true);
    expect(f.root.style.props["--color-text-primary"]).toBe("#abc");
  });

  test("waits for a result, and a refused initialize leaves a note", async () => {
    const f = fakeHost({ silent: true });
    mountRun(f.win as never, f.doc as never, fakeTimers().timers);
    expect(text(f)).toContain("Waiting");
    await f.tick();
    f.deliver({ jsonrpc: "2.0", id: f.sent[0]?.id, error: { code: -1, message: "no" } });
    await f.tick();
    expect(text(f)).toContain("supports MCP Apps");
  });
});

describe("run widget: the list", () => {
  const rows = [
    { run_id: "r1", status: "running", updated_at: "10:00" },
    {
      run_id: "r2",
      status: "planned",
      updated_at: "09:00",
      needs_you: "plan ready, approve it: heph approve plan r2",
    },
    { run_id: "r3", status: "finished", updated_at: "08:00" },
    { run_id: "r4", status: "staged", updated_at: "07:00" },
    { run_id: "r5", status: "escalated", updated_at: "06:00" },
  ];

  test("a compact table, runs that need you first, each with its command", async () => {
    const { f } = await mount(list(rows));
    const trs = f.body.byClass("run-row");
    expect(trs.map((r) => r.byClass("run-id")[0]?.textContent)).toEqual([
      "r2",
      "r4",
      "r5",
      "r1",
      "r3",
    ]);
    expect(trs[0]?.textContent).toContain("heph approve plan r2");
    expect(trs[1]?.byClass("cmd")[0]?.textContent).toBe("heph approve merge r4");
    expect(trs[2]?.byClass("cmd")[0]?.textContent).toBe("heph explain r5");
    expect(trs[3]?.textContent).toContain("10:00");
    expect(trs[3]?.byClass("cmd")).toHaveLength(0);
    expect(f.body.byClass("unit")).toHaveLength(0);
  });

  test("an empty list says so", async () => {
    const { f } = await mount(list([]));
    expect(text(f)).toContain("No runs");
  });

  test("hostile run ids and needs_you are inert", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    const { f } = await mount(
      list([{ run_id: evil, status: evil, updated_at: evil, needs_you: evil }]),
    );
    expect(f.body.find((e) => e.tag === "img")).toEqual([]);
    expect(text(f)).toContain(evil);
  });

  test("the list has no buttons without server tools", async () => {
    const { f } = await mount(list(rows));
    expect(buttons(f)).toEqual([]);
  });
});

describe("run widget: capability gating", () => {
  test("without serverTools: no Refresh, no polling, no tool calls", async () => {
    const { f, t } = await mount(one());
    expect(buttons(f)).toEqual([]);
    expect(t.active()).toBe(0);
    await t.advance(60_000);
    expect(calls(f)).toHaveLength(0);
  });

  test("has no cancel, hint or approve controls even with serverTools", async () => {
    const { f } = await mount(
      one({ run: { run_id: "r1", status: "planned" }, plan_approved: false }),
      withTools,
    );
    await f.tick();
    const bs = buttons(f);
    expect(bs.map((b) => b.textContent)).toEqual(["Refresh"]);
    expect(f.body.find((e) => ["input", "form", "select", "textarea"].includes(e.tag))).toEqual([]);
  });

  test("with serverTools Refresh calls heph_status for the run and re-renders", async () => {
    const { f } = await mount({ ...one(), graph: graph() }, withTools);
    await f.tick();
    const [btn] = buttons(f);
    expect(btn?.textContent).toBe("Refresh");
    btn?.click();
    expect(calls(f)).toHaveLength(1);
    expect(calls(f)[0]?.params).toEqual({ name: "heph_status", arguments: { run: "r1" } });
    answerNext(f, result({ ...one({ run: { run_id: "r1", status: "staged" } }), graph: graph() }));
    await f.tick();
    expect(f.body.byClass("badge")[0]?.textContent).toBe("staged");
    expect(f.body.byClass("error")).toHaveLength(0);
  });

  test("Refresh on the list calls heph_status with no run", async () => {
    const { f } = await mount(list([{ run_id: "r1", status: "running" }]), withTools);
    await f.tick();
    buttons(f)[0]?.click();
    expect(calls(f)[0]?.params).toEqual({ name: "heph_status", arguments: {} });
    answerNext(f, result(list([{ run_id: "r9", status: "running" }])));
    await f.tick();
    expect(text(f)).toContain("r9");
  });

  test("a second click while one is in flight does nothing", async () => {
    const { f } = await mount(one(), withTools);
    await f.tick();
    buttons(f)[0]?.click();
    buttons(f)[0]?.click();
    expect(calls(f)).toHaveLength(1);
  });

  test("polls every 5 s while the run is not final, and stops once it is staged", async () => {
    const { f, t } = await mount(one(), withTools);
    await f.tick();
    expect(t.active()).toBe(1);
    await t.advance(4_900);
    expect(calls(f)).toHaveLength(0);
    await t.advance(200);
    expect(calls(f)).toHaveLength(1);
    answerNext(f, result(one()));
    await f.tick();
    await t.advance(5_000);
    expect(calls(f)).toHaveLength(2);
    answerNext(f, result(one({ run: { run_id: "r1", status: "staged" } })));
    await f.tick();
    expect(t.active()).toBe(0);
    await t.advance(30_000);
    expect(calls(f)).toHaveLength(2);
  });

  test("final statuses never poll: staged, finished, failed, cancelled", async () => {
    for (const status of ["staged", "finished", "failed", "cancelled"]) {
      const { f, t } = await mount(one({ run: { run_id: "r1", status } }), withTools);
      await f.tick();
      expect(t.active()).toBe(0);
      await t.advance(20_000);
      expect(calls(f)).toHaveLength(0);
    }
  });

  test("the list is not polled", async () => {
    const { f, t } = await mount(list([{ run_id: "r1", status: "running" }]), withTools);
    await f.tick();
    expect(t.active()).toBe(0);
  });

  test("a failed refresh keeps the last view and shows an error note; the next success clears it", async () => {
    const { f } = await mount({ ...one(), graph: graph() }, withTools);
    await f.tick();
    buttons(f)[0]?.click();
    answerNext(f, undefined, "IPC not available");
    await f.tick();
    expect(f.body.byClass("unit")).toHaveLength(2);
    expect(f.body.byClass("error")[0]?.textContent).toContain("IPC not available");
    buttons(f)[0]?.click();
    answerNext(f, result(one()));
    await f.tick();
    expect(f.body.byClass("error")).toHaveLength(0);
  });

  test("an isError result keeps the view and shows the tool's message", async () => {
    const { f } = await mount(one(), withTools);
    await f.tick();
    buttons(f)[0]?.click();
    answerNext(f, {
      isError: true,
      content: [{ type: "text", text: "heph daemon is not running" }],
    });
    await f.tick();
    expect(f.body.byClass("error")[0]?.textContent).toContain("heph daemon is not running");
    expect(f.body.byClass("unit")).toHaveLength(2);
  });

  test("an unreadable answer keeps the view and notes it", async () => {
    const { f } = await mount(one(), withTools);
    await f.tick();
    buttons(f)[0]?.click();
    answerNext(f, { content: [], structuredContent: { weird: true } });
    await f.tick();
    expect(f.body.byClass("error")).toHaveLength(1);
    expect(f.body.byClass("unit")).toHaveLength(2);
  });

  test("a host that never answers times out and unblocks Refresh", async () => {
    const { f, t } = await mount(one(), withTools);
    await f.tick();
    buttons(f)[0]?.click();
    await t.advance(25_000);
    expect(f.body.byClass("error")[0]?.textContent).toContain("did not answer");
    buttons(f)[0]?.click();
    expect(calls(f).length).toBeGreaterThanOrEqual(2);
  });

  test("a result the host pushes replaces the view and polling follows its status", async () => {
    const { f, t } = await mount(one(), withTools);
    await f.tick();
    expect(t.active()).toBe(1);
    f.notify(
      "ui/notifications/tool-result",
      result(one({ run: { run_id: "r1", status: "finished" } })),
    );
    expect(f.body.byClass("badge")[0]?.textContent).toBe("finished");
    expect(t.active()).toBe(0);
  });

  test("an unchanged poll does not redraw (expanded cards stay open)", async () => {
    const { f, t } = await mount({ ...one(), graph: graph() }, withTools);
    await f.tick();
    const card = f.body.byClass("unit")[0];
    await t.advance(5_000);
    answerNext(f, result({ ...one(), graph: graph() }));
    await f.tick();
    expect(f.body.byClass("unit")[0]).toBe(card);
  });

  test("a card the user opened stays open across a redraw", async () => {
    const { f } = await mount({ ...one(), graph: graph() }, withTools);
    await f.tick();
    const card = f.body.byClass("unit")[0];
    if (card) {
      card.attrs.open = "";
      Object.assign(card, { open: true });
    }
    for (const fn of card?.listeners.toggle ?? []) fn();
    f.notify(
      "ui/notifications/tool-result",
      result({ ...one({ run: { run_id: "r1", status: "paused" } }), graph: graph() }),
    );
    expect(f.body.byClass("unit")[0]?.attrs.open).toBeDefined();
  });
});
