import { describe, expect, test } from "bun:test";
import { inFlightLines, mergeText, statusText } from "../src/main.ts";
import { describe as explainLine } from "../src/runtime.ts";
import { isMilestone, type WatchEvent, watchRun } from "../src/watch.ts";

const ev = (id: string, type: string, summary: string, unit_id?: string, attempt?: number) =>
  ({
    id,
    type,
    summary,
    ...(unit_id ? { unit_id } : {}),
    ...(attempt ? { attempt } : {}),
  }) as WatchEvent;

/** A run that moves through scripted (status, events) steps, one per poll. */
function script(
  steps: {
    status: string;
    approved?: boolean;
    events: WatchEvent[];
    stack_on?: { run_id: string; status: string };
  }[],
) {
  let i = 0;
  const at = () => steps[Math.min(i, steps.length - 1)] as (typeof steps)[number];
  return {
    view: {
      status: async () => ({
        run: { status: at().status },
        plan_approved: at().approved ?? true,
        ...(at().stack_on ? { stack_on: at().stack_on } : {}),
      }),
      explain: async () => {
        const e = { events: at().events };
        i++;
        return e;
      },
    },
  };
}
const run = async (steps: Parameters<typeof script>[0]) => {
  const lines: string[] = [];
  const r = await watchRun("r1", script(steps).view, (l) => lines.push(l), {
    sleep: async () => {},
  });
  return { lines, r };
};

describe("heph watch", () => {
  test("filters noise, keeps milestones", () => {
    expect(isMilestone(ev("1", "gate.result", "diff_scope pass: ok"))).toBe(false);
    expect(isMilestone(ev("2", "context.pack_built", "x"))).toBe(false);
    expect(isMilestone(ev("3", "unit.accepted", "unit accepted"))).toBe(true);
    expect(isMilestone(ev("4", "effect.done", "pr open done https://github.com/o/r/pull/1"))).toBe(
      true,
    );
    expect(isMilestone(ev("5", "effect.done", "push done"))).toBe(false);
  });

  test("a stalled unit is a milestone and the run ends as waiting for you", async () => {
    expect(isMilestone(ev("1", "unit.stalled", "stalled", "T2"))).toBe(true);
    const stalled = ev(
      "2",
      "unit.stalled",
      "stalled: tests failed the same way on a1 and a2",
      "T2",
    );
    const paused = ev("3", "run.paused", "run paused: waiting for you");
    const { lines, r } = await run([{ status: "paused", events: [stalled, paused] }]);
    expect(lines).toEqual([
      "r1: paused",
      "T2 stalled: tests failed the same way on a1 and a2",
      "run paused: waiting for you",
      "r1: waiting for you; heph explain r1",
    ]);
    expect(r).toEqual({ run_id: "r1", status: "paused", reason: "waiting for you" });
  });

  test("explain says which gate failed the same way", () => {
    const data = {
      signature: "abc",
      attempts: [1, 2],
      failing: [
        { gate: "impl", reason: "a" },
        { gate: "impl", reason: "b" },
      ],
    };
    expect(explainLine({ type: "unit.stalled", data })).toBe(
      "stalled: impl failed the same way on a1 and a2",
    );
  });

  test("a staged child of an unmerged parent ends with waiting for the parent", async () => {
    const staged = ev("1", "merge.staged", "staged");
    const { lines, r } = await run([
      { status: "staged", events: [staged], stack_on: { run_id: "A", status: "staged" } },
    ]);
    expect(lines.at(-1)).toBe("waiting for A");
    expect(lines).not.toContain("r1: staged; review, then heph approve merge r1");
    expect(r).toEqual({ run_id: "r1", status: "staged", reason: "waiting for A" });
    // Once the parent is finished the child is a normal staged run.
    const done = await run([
      { status: "staged", events: [staged], stack_on: { run_id: "A", status: "finished" } },
    ]);
    expect(done.lines.at(-1)).toBe("r1: staged; review, then heph approve merge r1");
  });

  test("a staged child of a failed parent says to rebuild, not to wait", async () => {
    const staged = ev("1", "merge.staged", "staged");
    const { lines, r } = await run([
      { status: "staged", events: [staged], stack_on: { run_id: "A", status: "failed" } },
    ]);
    expect(lines.at(-1)).toBe("stacked on A (failed): rebuild r1");
    expect(lines).not.toContain("waiting for A");
    expect(r.reason).toBe("stacked on A (failed): rebuild r1");
  });

  test("the status text lists the stack line and the attempts in flight", () => {
    const text = statusText({
      run: { run_id: "B", status: "running" },
      plan_approved: true,
      stack_on: { run_id: "A", status: "staged" },
      units: [],
      attempts: [
        { unit_id: "T1", attempt: 1, status: "running" },
        { unit_id: "T2", attempt: 1, status: "running" },
      ],
      usage: [],
    });
    expect(text).toContain("  stacked on A (staged)\n");
    expect(text).toContain("  in flight: T1/a1, T2/a1\n");
  });

  test("status shows the stack line and, with parallel units, what is in flight", () => {
    expect(
      inFlightLines([
        { unit_id: "T1", attempt: 1, status: "running" },
        { unit_id: "T2", attempt: 2, status: "running" },
        { unit_id: "T3", attempt: 1, status: "finished" },
      ]),
    ).toEqual(["  in flight: T1/a1, T2/a2"]);
    expect(inFlightLines([{ unit_id: "T1", attempt: 1, status: "running" }])).toEqual([]);
    expect(explainLine({ type: "run.created", data: { stack_on: "A" } })).toBe(
      "run created, stacked on A",
    );
    expect(explainLine({ type: "run.created", data: {} })).toBe("run created");
  });

  test("a retarget names its branch whole; other effects cut their sha", () => {
    const url = "https://github.com/acme/calc/pull/2";
    expect(
      explainLine({
        type: "effect.intended",
        data: { effect: "pr_retarget", key: "pr_retarget:calc", target: url, after: "release/1.x" },
      }),
    ).toBe(`pr retarget: ${url} to release/1.x`);
    expect(
      explainLine({
        type: "effect.intended",
        data: { effect: "push", key: "push:calc", target: "heph/B", after: "a".repeat(40) },
      }),
    ).toBe("push: heph/B to aaaaaaa");
  });

  test("a restacked merge result says what to do next", () => {
    expect(
      mergeText({
        run_id: "B",
        result: { status: "restacked", onto: { calc: "main", web: "main" } },
      }),
    ).toBe("restacked B onto main: review it, then run heph approve merge B again\n");
  });

  test("prints new milestones and ends when staged", async () => {
    const a = ev("1", "run.resumed", "run resumed");
    const b = ev("2", "unit.attempt.started", "attempt 1 started", "T1", 1);
    const g = ev("3", "gate.result", "tests pass: ok", "T1", 1);
    const c = ev("4", "unit.accepted", "unit accepted", "T1");
    const { lines, r } = await run([
      { status: "running", events: [a] },
      { status: "running", events: [a, b, g] },
      { status: "running", events: [a, b, g, c] },
      { status: "staged", events: [a, b, g, c] },
    ]);
    expect(lines).toEqual([
      "r1: running",
      "run resumed",
      "T1/a1 attempt 1 started",
      "T1 unit accepted",
      expect.stringContaining("r1: staged; review, then heph approve merge r1"),
    ]);
    expect(r.status).toBe("staged");
  });

  test("stops when the run waits for the user, and says why", async () => {
    const p = ev("1", "run.paused", "run paused: waiting for you");
    const { lines, r } = await run([
      { status: "running", events: [] },
      { status: "paused", events: [p] },
    ]);
    expect(lines.at(-1)).toContain("waiting for you; heph explain r1");
    expect(lines).toContain("run paused: waiting for you");
    expect(r.reason).toBe("waiting for you");
  });

  test("waits out a pause that is not for the user", async () => {
    const p = ev("1", "run.paused", "run paused: rate_limit");
    const { r } = await run([
      { status: "running", events: [] },
      { status: "paused", events: [p] },
      { status: "paused", events: [p] },
      { status: "failed", events: [p] },
    ]);
    expect(r.status).toBe("failed");
  });

  test("tells the user about an unapproved plan once", async () => {
    const { lines } = await run([
      { status: "planned", approved: false, events: [] },
      { status: "planned", approved: false, events: [] },
      { status: "finished", events: [] },
    ]);
    expect(lines.filter((l) => l.includes("waiting for your approval"))).toHaveLength(1);
  });

  test("retries transient errors, then gives up", async () => {
    let n = 0;
    const view = {
      status: async () => {
        if (n++ < 2) throw new Error("daemon restarting");
        return { run: { status: "finished" }, plan_approved: true };
      },
      explain: async () => ({ events: [] }),
    };
    const r = await watchRun("r1", view, () => {}, { sleep: async () => {} });
    expect(r.status).toBe("finished");
    const dead = { ...view, status: async () => Promise.reject(new Error("gone")) };
    await expect(
      watchRun("r1", dead, () => {}, { sleep: async () => {}, retries: 2 }),
    ).rejects.toThrow("gone");
  });

  test("catches up on the last milestones when started mid-run", async () => {
    const evs = ["1", "2", "3", "4", "5"].map((n) => ev(n, "unit.accepted", `done ${n}`, `T${n}`));
    const { lines } = await run([{ status: "finished", events: evs }]);
    expect(lines.slice(0, 4)).toEqual(["r1: finished", "T3 done 3", "T4 done 4", "T5 done 5"]);
  });

  test("says it is still working while an attempt runs silently", async () => {
    let t = Date.parse("2026-11-05T00:00:00Z");
    const started = {
      ...ev("1", "unit.attempt.started", "attempt 1 started", "T2", 1),
      ts: new Date(t).toISOString(),
    };
    const steps = [
      { status: "running", events: [started] },
      { status: "running", events: [started] },
      { status: "running", events: [started] },
      { status: "finished", events: [started] },
    ];
    const s = script(steps);
    const lines: string[] = [];
    await watchRun("r1", s.view, (l) => lines.push(l), {
      sleep: async () => {
        t += 90_000;
      },
      now: () => t,
      heartbeatMs: 60_000,
    });
    expect(lines.some((l) => /^T2\/a1 still working, \d+ min into this attempt$/.test(l))).toBe(
      true,
    );
  });
});
