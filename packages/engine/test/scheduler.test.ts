import { describe, expect, test } from "bun:test";
import { deriveEdges, type Plan, type Task, topoOrder, type Workspace } from "@hephaestus/core";
import { Stopped } from "../src/effects.ts";
import {
  isPauseReason,
  rampStart,
  rateLimitRamp,
  schedule,
  type UnitResult,
} from "../src/scheduler.ts";

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

  test("start throwing drains, then rethrows the first error", async () => {
    const c = controlled();
    const accepted = new Map<string, string[]>();
    const p = plan([task("T1"), task("T2"), task("T3")]);
    const out = schedule({
      plan: p,
      workspace,
      parallel: 2,
      accepted,
      scopeOf: (id) => [`${id}.go`],
      start: (id) => (id === "T1" ? Promise.reject(new Error("boom")) : c.start(id)),
      stopped: () => false,
    });
    await c.waitStarted("T2");
    await tick();
    expect(c.started).toEqual(["T2"]);
    c.finish("T2", ok(["b.go"]));
    await expect(out).rejects.toThrow("boom");
    expect(accepted.get("T2")).toEqual(["b.go"]);
    expect(c.started).toEqual(["T2"]);
  });

  test("a cancel arriving after a pause still returns cancelled", async () => {
    const c = controlled();
    const { out } = run(plan([task("T1"), task("T2")]), 2, c);
    await c.waitStarted("T2");
    c.finish("T1", { status: "paused", reason: "user", detail: "T1: blocked: x" });
    await tick();
    c.finish("T2", { status: "cancelled", reason: "cancelled by user" });
    expect(await out).toEqual({ kind: "cancelled", reason: "cancelled by user" });
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

  test("after a rate-limit resume the parallelism ramps 1, 2, 3, one more per accepted unit", async () => {
    const c = controlled();
    const accepted = new Map<string, string[]>();
    const p = plan(["T1", "T2", "T3", "T4", "T5", "T6"].map((id) => task(id)));
    const out = schedule({
      plan: p,
      workspace,
      parallel: 3,
      ramp: rampStart(3, 0),
      accepted,
      scopeOf: (id) => [`${id}.go`],
      start: c.start,
      stopped: () => false,
    });
    await c.waitStarted("T1");
    await tick();
    expect(c.inFlight()).toEqual(["T1"]);
    c.finish("T1", ok());
    await c.waitStarted("T3");
    await tick();
    expect(c.inFlight()).toEqual(["T2", "T3"]);
    c.finish("T2", ok());
    await c.waitStarted("T5");
    await tick();
    expect(c.inFlight()).toEqual(["T3", "T4", "T5"]);
    c.finish("T3", ok());
    await c.waitStarted("T6");
    await tick();
    expect(c.inFlight()).toEqual(["T4", "T5", "T6"]);
    for (const id of ["T4", "T5", "T6"]) c.finish(id, ok());
    expect(await out).toEqual({ kind: "done" });
    expect(c.maxInFlight()).toBe(3);
  });

  test("rampStart: half the configured parallelism (at least 1), plus units accepted since, capped", () => {
    expect([0, 1, 2, 3].map((n) => rampStart(3, n))).toEqual([1, 2, 3, 3]);
    expect([0, 1, 5].map((n) => rampStart(1, n))).toEqual([1, 1, 1]);
    expect([0, 1, 2, 3].map((n) => rampStart(4, n))).toEqual([2, 3, 4, 4]);
  });

  test("a ramp at configured parallel 1 stays 1", async () => {
    const c = controlled();
    const stop = autoAccept(c);
    const accepted = new Map<string, string[]>();
    const p = plan(["T1", "T2", "T3"].map((id) => task(id)));
    const out = await schedule({
      plan: p,
      workspace,
      parallel: 1,
      ramp: rampStart(1, 0),
      accepted,
      scopeOf: (id) => [`${id}.go`],
      start: c.start,
      stopped: () => false,
    });
    stop();
    expect(out).toEqual({ kind: "done" });
    expect(c.started).toEqual(["T1", "T2", "T3"]);
    expect(c.maxInFlight()).toBe(1);
  });

  test("rateLimitRamp comes from the ledger alone: a crash mid-ramp resumes at the same value", () => {
    const resumed = (reason: string) => ({ type: "run.resumed", data: { reason } });
    const acceptedEv = { type: "unit.accepted", data: {} };
    const paused = { type: "run.paused", data: { reason: "rate_limit" } };
    expect(rateLimitRamp([], 3)).toBeUndefined();
    expect(rateLimitRamp([acceptedEv, resumed("crash")], 3)).toBeUndefined();
    expect(rateLimitRamp([paused, resumed("rate_limit")], 3)).toBe(1);
    expect(rateLimitRamp([paused, resumed("rate_limit"), acceptedEv, resumed("crash")], 3)).toBe(2);
    expect(rateLimitRamp([resumed("rate_limit"), acceptedEv, acceptedEv, acceptedEv], 3)).toBe(3);
    // Paused again for something else and resumed: the throttle is over.
    expect(rateLimitRamp([resumed("rate_limit"), resumed("user")], 3)).toBeUndefined();
    expect(rateLimitRamp([resumed("rate_limit")], 1)).toBe(1);
  });

  test("a Stopped (a simulated kill) rejects at once, without waiting for units in flight", async () => {
    const c = controlled();
    const accepted = new Map<string, string[]>();
    const out = schedule({
      plan: plan([task("T1"), task("T2"), task("T3")]),
      workspace,
      parallel: 2,
      accepted,
      scopeOf: (id) => [`${id}.go`],
      start: (id) => (id === "T1" ? Promise.reject(new Stopped("killed")) : c.start(id)),
      stopped: () => false,
    });
    await expect(out).rejects.toBeInstanceOf(Stopped);
    expect(c.inFlight()).toEqual(["T2"]);
    // T2 settling later is never recorded: the process it ran in is gone.
    c.finish("T2", ok(["b.go"]));
    await tick();
    expect(accepted.size).toBe(0);
    expect(c.started).toEqual(["T2"]);
  });

  test("isPauseReason matches the pause reasons only, never an object prototype key", () => {
    expect(["handoff", "user", "rate_limit"].map(isPauseReason)).toEqual([true, true, true]);
    expect(["crash", "toString", "constructor", "__proto__", ""].map(isPauseReason)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
