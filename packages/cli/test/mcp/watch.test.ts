import { describe, expect, test } from "bun:test";
import { DaemonError, DaemonTimeoutError } from "../../src/daemon.ts";
import { NoDaemonError } from "../../src/mcp/guard.ts";
import { watchText } from "../../src/mcp/text.ts";
import { StepDeadlineError, watchStep } from "../../src/mcp/watch.ts";
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
    const boom = new NoDaemonError();
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
    const boom = new NoDaemonError();
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

  test("an answered daemon error (unknown run) fails at once, without retries", async () => {
    const unknown = new DaemonError("unknown run r9");
    const s = script([{ status: "running", events: [A], fail: unknown }]);
    const c = clock();
    await expect(watchStep("r9", s.view, { waitMs: 20_000, retries: 8, ...c })).rejects.toBe(
      unknown,
    );
    expect(s.polls()).toBe(1);
    expect(c.now() - 1_000_000).toBe(0);
  });

  test("a non-daemon error (a drifted answer) is not retried either", async () => {
    const drift = new Error("Invalid input: expected object");
    const s = script([{ status: "running", events: [A], fail: drift }]);
    await expect(watchStep("r1", s.view, { waitMs: 20_000, ...clock() })).rejects.toBe(drift);
    expect(s.polls()).toBe(1);
  });

  test("a connection error is retried", async () => {
    const refused = Object.assign(new TypeError("ECONNREFUSED: connection refused"), {
      code: "ECONNREFUSED",
    });
    const ok: Step = { status: "running", events: [A] };
    const s = script([{ ...ok, fail: refused }, ok]);
    const c = clock();
    const r = await watchStep("r1", s.view, { waitMs: 20_000, retries: 8, ...c });
    expect(r.status).toBe("running");
    expect(s.polls()).toBe(2);
    expect(c.now() - 1_000_000).toBe(2000);
  });

  test("a timed-out call is retried", async () => {
    const slow = new DaemonTimeoutError("status", 20_000);
    const ok: Step = { status: "running", events: [A] };
    const s = script([{ ...ok, fail: slow }, { ...ok, fail: slow }, ok]);
    const r = await watchStep("r1", s.view, { waitMs: 20_000, retries: 8, ...clock() });
    expect(r.status).toBe("running");
    expect(s.polls()).toBe(3);
  });

  test("an aborted signal stops the poll at the next sleep, with an AbortError", async () => {
    const ac = new AbortController();
    const s = script([{ status: "running", events: [A] }]);
    let t = 1_000_000;
    let sleeps = 0;
    const p = watchStep("r1", s.view, {
      since: "01",
      waitMs: 20_000,
      signal: ac.signal,
      now: () => t,
      sleep: async (ms) => {
        // The host cancels during the second wait.
        if (++sleeps === 2) ac.abort();
        t += ms;
      },
    });
    const e = await p.catch((x: unknown) => x);
    expect((e as Error).name).toBe("AbortError");
    expect(s.polls()).toBe(2);
    expect(t - 1_000_000).toBeLessThan(20_000);
  });

  test("an already aborted signal polls nothing", async () => {
    const ac = new AbortController();
    ac.abort();
    const s = script([{ status: "running", events: [A] }]);
    const e = await watchStep("r1", s.view, {
      since: "01",
      waitMs: 20_000,
      signal: ac.signal,
      ...clock(),
    }).catch((x: unknown) => x);
    expect((e as Error).name).toBe("AbortError");
    expect(s.polls()).toBe(0);
  });

  test("an abort also stops the retry wait of a transient error", async () => {
    const ac = new AbortController();
    const s = script([{ status: "running", events: [A], fail: new NoDaemonError() }]);
    const c = clock();
    const e = await watchStep("r1", s.view, {
      waitMs: 20_000,
      signal: ac.signal,
      now: c.now,
      sleep: async (ms) => {
        ac.abort();
        await c.sleep(ms);
      },
    }).catch((x: unknown) => x);
    expect((e as Error).name).toBe("AbortError");
    expect(s.polls()).toBe(1);
  });

  test("the default sleep wakes on abort and leaves no timer behind", async () => {
    const ac = new AbortController();
    const s = script([{ status: "running", events: [A] }]);
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 30);
    const e = await watchStep("r1", s.view, {
      since: "01",
      waitMs: 20_000,
      intervalMs: 10_000,
      signal: ac.signal,
    }).catch((x: unknown) => x);
    expect((e as Error).name).toBe("AbortError");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s.polls()).toBe(1);
  });

  test("an abort during status does not go on to explain", async () => {
    const ac = new AbortController();
    let explains = 0;
    const view = {
      status: async () => {
        ac.abort();
        return { run: { status: "running" }, plan_approved: true };
      },
      explain: async () => {
        explains++;
        return { events: [A] };
      },
    };
    const e = await watchStep("r1", view, {
      since: "01",
      waitMs: 20_000,
      signal: ac.signal,
      ...clock(),
    }).catch((x: unknown) => x);
    expect((e as Error).name).toBe("AbortError");
    expect(explains).toBe(0);
  });

  test("the abort reaches the daemon calls themselves", async () => {
    const ac = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const view = {
      status: (_id: string, signal?: AbortSignal) => {
        seen.push(signal);
        return new Promise<never>((_, fail) =>
          signal?.addEventListener("abort", () => fail(signal.reason), { once: true }),
        );
      },
      explain: async () => ({ events: [A] }),
    };
    setTimeout(() => ac.abort(), 20);
    const e = await watchStep("r1", view, { waitMs: 20_000, signal: ac.signal }).catch(
      (x: unknown) => x,
    );
    expect((e as Error).name).toBe("AbortError");
    expect(seen[0]?.aborted).toBe(true);
  });

  test("a hung daemon call is cut at the overall deadline (waitMs + graceMs)", async () => {
    const t0 = Date.now();
    const view = {
      status: () => new Promise<never>(() => {}),
      explain: async () => ({ events: [A] }),
    };
    const e = await watchStep("r1", view, { waitMs: 0, graceMs: 50 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StepDeadlineError);
    expect((e as Error).message).toContain("not answering in time");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("no new daemon call starts once the overall deadline has passed", async () => {
    const c = clock();
    let explains = 0;
    const view = {
      status: async () => {
        // A slow answer that lands after the step's whole budget.
        await c.sleep(40_000);
        return { run: { status: "running" }, plan_approved: true };
      },
      explain: async () => {
        explains++;
        return { events: [A] };
      },
    };
    const e = await watchStep("r1", view, { since: "01", waitMs: 20_000, ...c }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(StepDeadlineError);
    expect(explains).toBe(0);
  });

  test("slow but answering calls never hold the step past waitMs + 15 s", async () => {
    const c = clock();
    const view = {
      status: async () => {
        await c.sleep(9000);
        return { run: { status: "running" }, plan_approved: true };
      },
      explain: async () => {
        await c.sleep(9000);
        return { events: [A] };
      },
    };
    const r = await watchStep("r1", view, { since: "01", waitMs: 20_000, ...c }).catch(
      (x: unknown) => x,
    );
    // 18 s per poll: poll 1 ends at 18 s, poll 2 starts at 20 s and would end at 38 s.
    expect(r).toBeInstanceOf(StepDeadlineError);
    expect(c.now() - 1_000_000).toBeLessThanOrEqual(38_000);
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
    expect(r.outcome).toBe("waiting_for_parent");
    expect(r.lines.at(-1)).toBe("waiting for P");
  });

  test("a staged child of a failed parent says to rebuild, and next does not say wait", async () => {
    const s = script([
      { status: "staged", events: [A], stack_on: { run_id: "P", status: "failed" } },
    ]);
    const r = await watchStep("r1", s.view, { waitMs: 0, ...clock() });
    expect(r.lines.at(-1)).toBe("stacked on P (failed): rebuild r1");
    expect(r.lines).not.toContain("waiting for P");
    expect(watchText(r)).toContain("its parent cannot land");
  });

  test("next for a waiting child says to merge the parent first", async () => {
    const s = script([
      { status: "staged", events: [A], stack_on: { run_id: "P", status: "staged" } },
    ]);
    const r = await watchStep("r1", s.view, { waitMs: 0, ...clock() });
    const text = watchText(r);
    expect(text).toContain("wait for P");
    expect(text).toContain("heph approve merge P");
    expect(text).not.toContain("review, then run");
  });

  test("stacked behind an unmerged parent: waiting_for_parent, even without news", async () => {
    const staged = ev("05", "merge.staged", "staged");
    const s = script([
      { status: "staged", events: [A, staged], stack_on: { run_id: "P", status: "built" } },
    ]);
    const c = clock();
    const t0 = c.now();
    const r = await watchStep("r1", s.view, { since: "05", waitMs: 600_000, ...c });
    expect(c.now() - t0).toBe(0);
    expect(r).toMatchObject({ outcome: "waiting_for_parent", waiting_for: "P", cursor: "05" });
    expect(r.blocked).toBeUndefined();
    expect(r.lines).toEqual(["waiting for P"]);
    expect(watchText(r)).toContain(
      "next: wait for P: tell the user to merge it first (`heph approve merge P`, themselves); then r1 is restacked and the user approves it",
    );
  });

  test("a parent that failed: blocked_by_parent with the rebuild line", async () => {
    const staged = ev("05", "merge.staged", "staged");
    const s = script([
      { status: "staged", events: [A, staged], stack_on: { run_id: "P", status: "failed" } },
    ]);
    const r = await watchStep("r1", s.view, { since: "01", waitMs: 600_000, ...clock() });
    expect(r).toMatchObject({
      outcome: "blocked_by_parent",
      blocked: "stacked on P (failed): rebuild r1",
    });
    expect(r.waiting_for).toBeUndefined();
    expect(r.lines).toEqual(["staged", "stacked on P (failed): rebuild r1"]);
    const text = watchText(r);
    expect(text).toContain(
      "next: explain to the user that its parent cannot land, so r1 has to be rebuilt; ask; do not retry",
    );
    expect(text).not.toMatch(/approve/);
  });

  test("a cancelled parent blocks too; a finished one leaves a plain staged run", async () => {
    const cancelled = await watchStep(
      "r1",
      script([{ status: "staged", events: [A], stack_on: { run_id: "P", status: "cancelled" } }])
        .view,
      { waitMs: 0, ...clock() },
    );
    expect(cancelled.outcome).toBe("blocked_by_parent");
    expect(cancelled.lines.at(-1)).toBe("stacked on P (cancelled): rebuild r1");
    const landed = await watchStep(
      "r1",
      script([{ status: "staged", events: [A], stack_on: { run_id: "P", status: "finished" } }])
        .view,
      { waitMs: 0, ...clock() },
    );
    expect(landed.outcome).toBe("staged");
    expect(landed.lines).toEqual(["r1: staged", "run resumed"]);
  });

  test("a stalled unit pauses the run: waiting_for_you, with the stall line", async () => {
    const stalled = ev(
      "05",
      "unit.stalled",
      "stalled: tests failed the same way on a1 and a2",
      "T2",
    );
    const paused = ev("06", "run.paused", "run paused: waiting for you");
    const s = script([{ status: "paused", events: [A, stalled, paused] }]);
    const r = await watchStep("r1", s.view, { since: "01", waitMs: 600_000, ...clock() });
    expect(r.outcome).toBe("waiting_for_you");
    expect(r.lines).toEqual([
      "T2 stalled: tests failed the same way on a1 and a2",
      "run paused: waiting for you",
    ]);
    expect(watchText(r)).toContain("next: explain to the user and ask; do not retry");
  });
});
