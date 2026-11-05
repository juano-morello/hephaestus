import { describe, expect, test } from "bun:test";
import { watchStep } from "../../src/mcp/watch.ts";
import type { WatchEvent } from "../../src/watch.ts";

const ev = (
  id: string,
  type: string,
  summary: string,
  unit_id?: string,
  attempt?: number,
  ts?: string,
) =>
  ({
    id,
    type,
    summary,
    ...(unit_id ? { unit_id } : {}),
    ...(attempt ? { attempt } : {}),
    ...(ts ? { ts } : {}),
  }) as WatchEvent;

type Step = { status: string; approved?: boolean; events: WatchEvent[]; fail?: Error };
function script(steps: Step[]) {
  let i = 0;
  let polls = 0;
  const at = () => steps[Math.min(i, steps.length - 1)] as Step;
  return {
    polls: () => polls,
    view: {
      status: async () => {
        polls++;
        const s = at();
        if (s.fail) {
          i++;
          throw s.fail;
        }
        return { run: { status: s.status }, plan_approved: s.approved ?? true };
      },
      explain: async () => {
        const e = { events: at().events };
        i++;
        return e;
      },
    },
  };
}
const clock = (start = 1_000_000) => {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
};

const A = ev("01", "run.resumed", "run resumed");
const B = ev("02", "unit.attempt.started", "attempt 1 started", "T1", 1);
const G = ev("03", "gate.result", "tests pass: ok", "T1", 1);
const C = ev("04", "unit.accepted", "unit accepted", "T1");

describe("watchStep", () => {
  test("catch-up shows status line, last 3 milestones, newest cursor", async () => {
    const d = ev("05", "unit.attempt.finished", "attempt done", "T1", 1);
    const s = script([{ status: "running", events: [A, B, G, C, d] }]);
    const r = await watchStep("r1", s.view, { waitMs: 10_000, ...clock() });
    expect(r.lines).toEqual([
      "r1: running",
      "T1/a1 attempt 1 started",
      "T1 unit accepted",
      "T1/a1 attempt done",
    ]);
    expect(r.cursor).toBe("05");
    expect(r.outcome).toBe("running");
    expect(r.run_id).toBe("r1");
    expect(r.status).toBe("running");
  });

  test("with since: only newer milestones, never noise", async () => {
    const s = script([{ status: "running", events: [A, B, G, C] }]);
    const r = await watchStep("r1", s.view, { since: "02", waitMs: 10_000, ...clock() });
    expect(r.lines).toEqual(["T1 unit accepted"]);
    expect(r.cursor).toBe("04");
  });

  test("returns early on a new milestone", async () => {
    const s = script([
      { status: "running", events: [A, B] },
      { status: "running", events: [A, B, G] },
      { status: "running", events: [A, B, G, C] },
    ]);
    const c = clock();
    const t0 = c.now();
    const r = await watchStep("r1", s.view, { since: "02", waitMs: 600_000, ...c });
    expect(r.lines).toEqual(["T1 unit accepted"]);
    expect(c.now() - t0).toBeLessThan(10_000);
  });

  test("heartbeat after waitMs with an open attempt", async () => {
    const t0 = 1_000_000;
    const b = ev("02", "unit.attempt.started", "x", "T1", 1, new Date(t0 - 120_000).toISOString());
    const s = script([{ status: "running", events: [b] }]);
    const r = await watchStep("r1", s.view, {
      since: "02",
      waitMs: 5000,
      heartbeatMs: 1000,
      ...clock(t0),
    });
    expect(r.outcome).toBe("running");
    expect(r.lines).toEqual(["T1/a1 still working, 2 min into this attempt"]);
  });

  test("heartbeat without an open attempt", async () => {
    const s = script([{ status: "running", events: [A] }]);
    const r = await watchStep("r1", s.view, {
      since: "01",
      waitMs: 5000,
      heartbeatMs: 1000,
      ...clock(),
    });
    expect(r.lines).toEqual(["r1: still running"]);
  });

  test("no heartbeat while silence is shorter than heartbeatMs", async () => {
    const s = script([{ status: "running", events: [A] }]);
    const r = await watchStep("r1", s.view, { since: "01", waitMs: 5000, ...clock() });
    expect(r.lines).toEqual([]);
  });

  const cases: [string, Step, string][] = [
    [
      "planned+unapproved",
      { status: "planned", approved: false, events: [A] },
      "awaiting_plan_approval",
    ],
    ["escalated", { status: "escalated", events: [A] }, "planner_escalated"],
    [
      "paused waiting",
      { status: "paused", events: [ev("09", "run.paused", "run paused: waiting for you")] },
      "waiting_for_you",
    ],
    ["staged", { status: "staged", events: [A] }, "staged"],
    ["finished", { status: "finished", events: [A] }, "finished"],
    ["failed", { status: "failed", events: [A] }, "failed"],
    [
      "rate-limit pause",
      { status: "paused", events: [ev("09", "run.paused", "run paused: rate_limit")] },
      "running",
    ],
    ["built", { status: "built", events: [A] }, "running"],
    ["running", { status: "running", events: [A] }, "running"],
  ];
  for (const [name, step, outcome] of cases) {
    test(`outcome ${name} -> ${outcome}`, async () => {
      const c = clock();
      const t0 = c.now();
      const r = await watchStep("r1", script([step]).view, {
        since: "99",
        waitMs: 600_000,
        heartbeatMs: 1e9,
        ...c,
      });
      expect(r.outcome).toBe(outcome as never);
      if (outcome !== "running") expect(c.now() - t0).toBe(0);
    });
  }

  test("waitMs 0 polls once", async () => {
    const s = script([{ status: "running", events: [A] }]);
    await watchStep("r1", s.view, { since: "01", waitMs: 0, ...clock() });
    expect(s.polls()).toBe(1);
  });

  test("retries transient status errors, then rejects", async () => {
    const boom = new Error("daemon down");
    const ok: Step = { status: "running", events: [A] };
    const r = await watchStep(
      "r1",
      script([{ ...ok, fail: boom }, { ...ok, fail: boom }, ok]).view,
      {
        waitMs: 0,
        retries: 5,
        ...clock(),
      },
    );
    expect(r.status).toBe("running");
    const last = new Error("last");
    await expect(
      watchStep(
        "r1",
        script([
          { ...ok, fail: boom },
          { ...ok, fail: boom },
          { ...ok, fail: last },
        ]).view,
        {
          waitMs: 0,
          retries: 2,
          ...clock(),
        },
      ),
    ).rejects.toBe(last);
  });

  test("onLine receives each line", async () => {
    const got: string[] = [];
    const s = script([{ status: "running", events: [A, B] }]);
    const r = await watchStep("r1", s.view, { waitMs: 0, onLine: (l) => got.push(l), ...clock() });
    expect(got).toEqual(r.lines);
    expect(got.length).toBe(3);
  });
});
