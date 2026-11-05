import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { usePoll } from "../src/use-poll.ts";

type Timer = { fn: () => void; ms: number; id: number };
let timers: Timer[] = [];
let nextId = 1;
const real = { st: globalThis.setTimeout, ct: globalThis.clearTimeout };

beforeEach(() => {
  timers = [];
  nextId = 1;
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const t = { fn, ms, id: nextId++ };
    timers.push(t);
    return t.id;
  }) as never;
  globalThis.clearTimeout = ((id: number) => {
    timers = timers.filter((t) => t.id !== id);
  }) as never;
});

afterEach(() => {
  cleanup();
  globalThis.setTimeout = real.st;
  globalThis.clearTimeout = real.ct;
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});

/** Fires the pending poll timer (the hook keeps at most one), then lets promises settle. */
const fire = async () => {
  const t = timers.shift();
  await act(async () => {
    t?.fn();
    await Promise.resolve();
  });
};
const flush = () => act(async () => {});

describe("usePoll", () => {
  test("polls at fastMs while running and slowMs otherwise", async () => {
    let state = "running";
    let calls = 0;
    const fn = async () => {
      calls++;
      return state;
    };
    const { result } = renderHook(() =>
      usePoll(fn, { fastMs: 2000, slowMs: 10000, fast: (v) => v === "running" }),
    );
    await flush();
    expect(calls).toBe(1);
    expect(result.current.data).toBe("running");
    expect(timers.map((t) => t.ms)).toEqual([2000]);
    await fire();
    expect(calls).toBe(2);
    state = "done";
    await fire();
    expect(calls).toBe(3);
    expect(result.current.data).toBe("done");
    expect(timers.map((t) => t.ms)).toEqual([10000]);
  });

  test("does not poll while the document is hidden", async () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    let calls = 0;
    renderHook(() => usePoll(async () => ++calls, { fastMs: 10, slowMs: 20, fast: () => true }));
    await flush();
    expect(calls).toBe(0);
    expect(timers.length).toBe(0);
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(calls).toBe(1);
  });

  test("stops after unmount", async () => {
    let calls = 0;
    const { unmount } = renderHook(() =>
      usePoll(async () => ++calls, { fastMs: 10, slowMs: 20, fast: () => true }),
    );
    await flush();
    expect(timers.length).toBe(1);
    unmount();
    expect(timers.length).toBe(0);
    expect(calls).toBe(1);
  });
});
