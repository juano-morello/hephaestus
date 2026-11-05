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

type Step = {
  status: string;
  approved?: boolean;
  events: WatchEvent[];
  fail?: Error;
  stack_on?: { run_id: string; status: string };
};
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
        return {
          run: { status: s.status },
          plan_approved: s.approved ?? true,
          ...(s.stack_on ? { stack_on: s.stack_on } : {}),
        };
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

  test("default options: a quiet 20 s long-poll ends with a heartbeat", async () => {
    const s = script([{ status: "running", events: [A] }]);
    const r = await watchStep("r1", s.view, { since: "01", waitMs: 20_000, ...clock() });
    expect(r.outcome).toBe("running");
    expect(r.lines).toEqual(["r1: still running"]);
  });

  test("waitMs 0 with no news still returns a heartbeat", async () => {
    const s = script([{ status: "running", events: [A] }]);
    const r = await watchStep("r1", s.view, { since: "01", waitMs: 0, ...clock() });
    expect(r.lines).toEqual(["r1: still running"]);
  });

  test("heartbeatMs, when set, suppresses a shorter quiet poll", async () => {
    const s = script([{ status: "running", events: [A] }]);
    const r = await watchStep("r1", s.view, {
      since: "01",
      waitMs: 5000,
      heartbeatMs: 60_000,
      ...clock(),
    });
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
        waitMs: 10_000,
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
          waitMs: 10_000,
          retries: 2,
          ...clock(),
        },
      ),
    ).rejects.toBe(last);
  });

  test("retries stop one interval past the deadline, whatever retries allows", async () => {
    const boom = new Error("daemon down");
    const fast = script([{ status: "running", events: [A], fail: boom }]);
    const c = clock();
    await expect(watchStep("r1", fast.view, { waitMs: 0, retries: 30, ...c })).rejects.toBe(boom);
    expect(fast.polls()).toBe(2);
    expect(c.now() - 1_000_000).toBe(2000);

    const slow = script([{ status: "running", events: [A], fail: boom }]);
    const c2 = clock();
    await expect(watchStep("r1", slow.view, { waitMs: 20_000, retries: 30, ...c2 })).rejects.toBe(
      boom,
    );
    expect(slow.polls()).toBe(12);
    expect(c2.now() - 1_000_000).toBe(22_000);
  });

  test("onLine receives each line", async () => {
    const got: string[] = [];
    const s = script([{ status: "running", events: [A, B] }]);
    const r = await watchStep("r1", s.view, { waitMs: 0, onLine: (l) => got.push(l), ...clock() });
    expect(got).toEqual(r.lines);
    expect(got.length).toBe(3);
  });

  test("a staged child of an unmerged parent ends with waiting for the parent", async () => {
    const s = script([
      { status: "staged", events: [A], stack_on: { run_id: "P", status: "staged" } },
    ]);
    const r = await watchStep("r1", s.view, { waitMs: 0, ...clock() });
    expect(r.outcome).toBe("staged");
    expect(r.lines.at(-1)).toBe("waiting for P");
  });
});
