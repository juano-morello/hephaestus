import { describe, expect, test } from "bun:test";
import { deriveEdges, type Plan, type Task, topoOrder, type Workspace } from "@hephaestus/core";
import { schedule, type UnitResult } from "../src/scheduler.ts";

const workspace: Workspace = {
  repos: { game: "." },
  projects: { server: { repo: "game", path: "server", stack: "go" } },
};

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: id,
  kind: "implement",
  project: "server",
  lane: "contained",
  complexity: "standard",
  complexity_reason: "x",
  scope: [`${id.toLowerCase()}.go`],
  covers: ["AC1"],
  spec: `do ${id}`,
  ...overrides,
});

const plan = (tasks: Task[]): Plan => ({ schema: 1, brief_hash: "h", tasks, risks: [] });

/** A `start` whose results the test resolves by hand; tracks what is in flight. */
function controlled() {
  const pending = new Map<string, (r: UnitResult) => void>();
  const started: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const waiters: (() => void)[] = [];
  const start = (id: string) =>
    new Promise<UnitResult>((resolve) => {
      started.push(id);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      pending.set(id, (r) => {
        pending.delete(id);
        inFlight--;
        resolve(r);
      });
      for (const w of waiters.splice(0)) w();
    });
  /** Waits until `id` has started. */
  const started_ = async (id: string) => {
    while (!started.includes(id)) await new Promise<void>((r) => waiters.push(r));
  };
  const finish = (id: string, r: UnitResult) => {
    const f = pending.get(id);
    if (!f) throw new Error(`${id} is not in flight`);
    f(r);
  };
  return {
    start,
    started,
    finish,
    waitStarted: started_,
    inFlight: () => [...pending.keys()],
    maxInFlight: () => maxInFlight,
  };
}

const ok = (files: string[] = []): UnitResult => ({ status: "accepted", files });
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

function run(p: Plan, parallel: number, c: ReturnType<typeof controlled>, stopped = () => false) {
  const accepted = new Map<string, string[]>();
  const byId = new Map(p.tasks.map((t) => [t.id, t]));
  const out = schedule({
    plan: p,
    workspace,
    parallel,
    accepted,
    scopeOf: (id) => byId.get(id)?.scope ?? [],
    start: c.start,
    stopped,
  });
  return { out, accepted };
}

/** Resolves every unit accepted as soon as it starts. */
function autoAccept(c: ReturnType<typeof controlled>) {
  let done = false;
  (async () => {
    while (!done) {
      for (const id of c.inFlight()) c.finish(id, ok([`${id}.go`]));
      await tick();
    }
  })();
  return () => {
    done = true;
  };
}

describe("schedule", () => {
  test("parallel_1_runs_in_canonical_order_one_at_a_time", async () => {
    const p = plan([
      task("T3", { consumes: ["fn:B"] }),
      task("T1", { produces: ["fn:A"] }),
      task("T2", { consumes: ["fn:A"], produces: ["fn:B"] }),
      task("T4"),
    ]);
    const c = controlled();
    const stop = autoAccept(c);
    const { out, accepted } = run(p, 1, c);
    expect(await out).toEqual({ kind: "done" });
    stop();
    const order = topoOrder(
      p.tasks.map((t) => t.id),
      deriveEdges(p.tasks).edges,
    );
    expect(order.ok && order.order).toEqual(c.started);
    expect(c.maxInFlight()).toBe(1);
    expect([...accepted.keys()].sort()).toEqual(["T1", "T2", "T3", "T4"]);
    expect(accepted.get("T2")).toEqual(["T2.go"]);
  });

  test("parallel_2_runs_independent_units_together", async () => {
    const p = plan([task("T1"), task("T2")]);
    const c = controlled();
    const { out } = run(p, 2, c);
    await c.waitStarted("T2");
    expect(c.inFlight().sort()).toEqual(["T1", "T2"]);
    c.finish("T2", ok());
    c.finish("T1", ok());
    expect(await out).toEqual({ kind: "done" });
    expect(c.maxInFlight()).toBe(2);
  });

  test("dependent_unit_waits", async () => {
    const p = plan([task("T1", { produces: ["fn:A"] }), task("T2", { consumes: ["fn:A"] })]);
    const c = controlled();
    const { out } = run(p, 2, c);
    await c.waitStarted("T1");
    await tick();
    expect(c.started).toEqual(["T1"]);
    c.finish("T1", ok());
    await c.waitStarted("T2");
    c.finish("T2", ok());
    expect(await out).toEqual({ kind: "done" });
    expect(c.started).toEqual(["T1", "T2"]);
  });

  test("drain_on_escalation", async () => {
    const p = plan([task("T1"), task("T2"), task("T3")]);
    const c = controlled();
    const { out, accepted } = run(p, 2, c);
    await c.waitStarted("T2");
    c.finish("T1", { status: "paused", reason: "user", detail: "T1: blocked: no" });
    await tick();
    expect(c.started).toEqual(["T1", "T2"]);
    c.finish("T2", ok(["b.go"]));
    expect(await out).toEqual({ kind: "paused", reason: "user", detail: "T1: blocked: no" });
    expect(c.started).toEqual(["T1", "T2"]);
    expect(accepted.get("T2")).toEqual(["b.go"]);
    expect(accepted.has("T1")).toBe(false);
  });

  test("pause_reason_precedence", async () => {
    const both = async (a: UnitResult, b: UnitResult) => {
      const c = controlled();
      const { out } = run(plan([task("T1"), task("T2")]), 2, c);
      await c.waitStarted("T2");
      c.finish("T1", a);
      await tick();
      c.finish("T2", b);
      return out;
    };
    const rate = (detail: string, retryAfter?: string): UnitResult => ({
      status: "paused",
      reason: "rate_limit",
      detail,
      ...(retryAfter ? { retryAfter } : {}),
    });
    const user: UnitResult = { status: "paused", reason: "user", detail: "T2: blocked: x" };
    const handoff: UnitResult = { status: "paused", reason: "handoff", detail: "T1: handoff" };

    expect(await both(rate("T1: rate_limit", "2026-11-05T10:00:00Z"), user)).toEqual({
      kind: "paused",
      reason: "user",
      detail: "T2: blocked: x",
    });
    expect(await both(handoff, user)).toEqual({
      kind: "paused",
      reason: "handoff",
      detail: "T1: handoff",
    });
    expect(
      await both(
        rate("T1: rate_limit", "2026-11-05T10:00:00Z"),
        rate("T2: rate_limit", "2026-11-05T11:00:00Z"),
      ),
    ).toEqual({
      kind: "paused",
      reason: "rate_limit",
      detail: "T1: rate_limit",
      retryAfter: "2026-11-05T11:00:00Z",
    });
    expect(
      await both(
        rate("T1: rate_limit", "2026-11-05T12:00:00Z"),
        rate("T2: rate_limit", "2026-11-05T11:00:00Z"),
      ),
    ).toMatchObject({ reason: "rate_limit", retryAfter: "2026-11-05T12:00:00Z" });
  });

  test("cancelled_wins", async () => {
    const c = controlled();
    const { out } = run(plan([task("T1"), task("T2")]), 2, c);
    await c.waitStarted("T2");
    c.finish("T1", { status: "cancelled", reason: "cancelled by user" });
    await tick();
    c.finish("T2", { status: "paused", reason: "handoff", detail: "T2: handoff" });
    expect(await out).toEqual({ kind: "cancelled", reason: "cancelled by user" });
  });

  test("stopped drains: nothing new starts, in-flight results are kept", async () => {
    let stop = false;
    const c = controlled();
    const { out, accepted } = run(plan([task("T1"), task("T2"), task("T3")]), 2, c, () => stop);
    await c.waitStarted("T2");
    stop = true;
    c.finish("T1", ok(["a.go"]));
    await tick();
    c.finish("T2", ok(["b.go"]));
    expect(await out).toEqual({ kind: "done" });
    expect(c.started).toEqual(["T1", "T2"]);
    expect([...accepted.keys()]).toEqual(["T1", "T2"]);
  });

  test("units already accepted are not started again", async () => {
    const c = controlled();
    const stopAuto = autoAccept(c);
    const accepted = new Map<string, string[]>([["T1", ["x.go"]]]);
    const p = plan([task("T1", { produces: ["fn:A"] }), task("T2", { consumes: ["fn:A"] })]);
    const out = await schedule({
      plan: p,
      workspace,
      parallel: 1,
      accepted,
      scopeOf: () => [],
      start: c.start,
      stopped: () => false,
    });
    stopAuto();
    expect(out).toEqual({ kind: "done" });
    expect(c.started).toEqual(["T2"]);
  });
});
