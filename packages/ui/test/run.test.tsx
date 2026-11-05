import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type Api, ApiError } from "../src/api.ts";
import { App } from "../src/app.tsx";
import type { Dashboard } from "../src/types.ts";
import { Run } from "../src/views/run.tsx";
import {
  bigRun,
  droppedUnitRun,
  noPlanRun,
  parallelRun,
  stackedChild,
  stalledRun,
} from "./fixtures.ts";

afterEach(cleanup);

const fakeApi = (result: Dashboard | ApiError): Api & { calls: unknown[][] } => {
  const calls: unknown[][] = [];
  return {
    calls,
    call: (async (...a: unknown[]) => {
      calls.push(a);
      if (result instanceof ApiError) throw result;
      return result;
    }) as Api["call"],
  };
};

const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as SVGGElement;

describe("Run graph", () => {
  test("renders one node per plan unit colored and labeled by status", async () => {
    const api = fakeApi(parallelRun);
    render(<Run id="r-par" api={api} />);
    await screen.findByLabelText("Unit graph");
    expect(api.calls[0]).toEqual(["dashboard", "r-par"]);
    const nodes = [...document.querySelectorAll("[data-node]")];
    expect(nodes.length).toBe(3);
    for (const [id, status] of [
      ["T1", "accepted"],
      ["T2", "running"],
      ["T3", "pending"],
    ] as const) {
      const n = node(id);
      expect(n.getAttribute("role")).toBe("button");
      expect(n.getAttribute("tabindex")).toBe("0");
      expect(n.getAttribute("data-status")).toBe(status);
      expect(n.textContent).toContain(status);
      expect(n.getAttribute("aria-label")).toContain(status);
    }
    const body = (id: string) => node(id).querySelector("rect:not([data-ring])") as SVGRectElement;
    expect(body("T1").getAttribute("stroke")).toBe("var(--primary)");
    expect(body("T2").getAttribute("stroke")).toBe("var(--accent)");
    expect(body("T3").getAttribute("stroke")).toBe("var(--border-strong)");
    expect(body("T3").getAttribute("stroke-dasharray")).toBeTruthy();
    expect(body("T1").getAttribute("stroke-dasharray")).toBeNull();
    expect(document.querySelectorAll("[data-edge]").length).toBe(2);
  });

  test("Enter and Space select a node, click too, and the selection ring shows", async () => {
    render(<Run id="r-par" api={fakeApi(parallelRun)} />);
    await screen.findByLabelText("Unit graph");
    expect(node("T1").getAttribute("data-selected")).toBe("false");
    fireEvent.keyDown(node("T1"), { key: "Enter" });
    expect(node("T1").getAttribute("data-selected")).toBe("true");
    fireEvent.keyDown(node("T2"), { key: " " });
    expect(node("T2").getAttribute("data-selected")).toBe("true");
    expect(node("T1").getAttribute("data-selected")).toBe("false");
    fireEvent.click(node("T3"));
    expect(node("T3").getAttribute("aria-pressed")).toBe("true");
  });

  test("twelve units all render", async () => {
    render(<Run id="r-big" api={fakeApi(bigRun)} />);
    await screen.findByLabelText("Unit graph");
    expect(document.querySelectorAll("[data-node]").length).toBe(12);
  });

  test("the graph sits in a scroll area so narrow screens scroll it", async () => {
    render(<Run id="r-big" api={fakeApi(bigRun)} />);
    const svg = await screen.findByLabelText("Unit graph");
    expect(svg.closest("[data-radix-scroll-area-viewport]")).toBeTruthy();
  });
});

describe("Run node rings", () => {
  test("focus and selection rings are different styles; the body rect has no dead pulse class", async () => {
    render(<Run id="r-par" api={fakeApi(parallelRun)} />);
    await screen.findByLabelText("Unit graph");
    const g = node("T2");
    const sel = g.querySelector('rect[data-ring="selected"]');
    const focus = g.querySelector('rect[data-ring="focus"]');
    expect(sel).toBeTruthy();
    expect(focus).toBeTruthy();
    expect(sel?.getAttribute("stroke-dasharray")).toBeNull();
    expect(focus?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(focus?.getAttribute("width")).not.toBe(sel?.getAttribute("width"));
    const body = g.querySelector("rect:not([data-ring])");
    expect(body?.getAttribute("class") ?? "").not.toContain("heph-pulse");
  });
});

const withGates = (unit: string, attempts: [number, string, string][]): Dashboard => ({
  ...stalledRun,
  attempts: attempts.map(([n, status, verdict]) => ({
    unit_id: unit,
    attempt: n,
    status,
    gates: [{ gate: "lint", verdict, reason: `R${n}`, evidence: [] }],
  })),
});

describe("Run poll updates", () => {
  const changing = (frames: Dashboard[]): Api => {
    let i = 0;
    return {
      call: (async () => frames[Math.min(i++, frames.length - 1)]) as Api["call"],
    };
  };
  const wait = (ms: number) =>
    act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  const live = (d: Dashboard): Dashboard => ({ ...d, run: { ...d.run, status: "running" } });

  test("the selection resets when the selected unit leaves the plan and the poll", async () => {
    const gone: Dashboard = {
      ...live(parallelRun),
      plan: { units: parallelRun.plan.units.filter((u) => u.id !== "T2") },
      units: parallelRun.units.filter((u) => u.unit_id !== "T2"),
      attempts: [],
    };
    render(<Run id="r-par" api={changing([live(parallelRun), gone, live(parallelRun)])} />);
    await screen.findByLabelText("Unit graph");
    fireEvent.click(node("T2"));
    expect(screen.getByRole("region", { name: "Unit T2" })).toBeTruthy();
    await wait(2100);
    expect(screen.queryByRole("region", { name: "Unit T2" })).toBeNull();
    // it was reset, not just hidden: bringing T2 back must not reselect it
    await wait(2100);
    expect(screen.queryByRole("region", { name: "Unit T2" })).toBeNull();
    expect(screen.getByText(/select a unit/i)).toBeTruthy();
  });

  test("the panel follows a newer attempt unless the user picked a tab", async () => {
    const one = live(withGates("T2", [[1, "failed", "fail"]]));
    const two = live(
      withGates("T2", [
        [1, "failed", "fail"],
        [2, "running", "pass"],
      ]),
    );
    const three = live(
      withGates("T2", [
        [1, "failed", "fail"],
        [2, "failed", "fail"],
        [3, "running", "pass"],
      ]),
    );
    render(<Run id="r-stall" api={changing([one, two, three])} />);
    await screen.findByLabelText("Unit graph");
    fireEvent.click(node("T2"));
    const sel = () =>
      screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")
        ?.textContent;
    expect(sel()).toBe("Attempt 1");
    await wait(2100);
    expect(sel()).toBe("Attempt 2");
    // an explicit choice is kept when attempt 3 arrives
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Attempt 1" }), { button: 0 });
    expect(sel()).toBe("Attempt 1");
    await wait(2100);
    expect(screen.getAllByRole("tab").length).toBe(3);
    expect(sel()).toBe("Attempt 1");
  });
});

describe("Run gate verdicts", () => {
  test("a skip verdict is neutral with its text, not the red failure icon", async () => {
    render(<Run id="r-stall" api={fakeApi(withGates("T2", [[1, "accepted", "skip"]]))} />);
    await screen.findByLabelText("Unit graph");
    fireEvent.click(node("T2"));
    const gate = document.querySelector('[data-gate="lint"]') as HTMLElement;
    const verdict = within(gate).getByText("skip");
    expect(verdict.className).not.toContain("text-danger");
    expect(verdict.className).not.toContain("text-primary");
    expect(gate.textContent).not.toContain("✕");
  });
});

describe("Run unit panel", () => {
  test("selecting a unit shows attempts and gates with evidence collapsed until opened", async () => {
    render(<Run id="r-stall" api={fakeApi(stalledRun)} />);
    await screen.findByLabelText("Unit graph");
    expect(screen.getByText(/select a unit/i)).toBeTruthy();
    fireEvent.click(node("T2"));
    const panel = screen.getByRole("region", { name: "Unit T2" });
    const tabs = within(panel).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Attempt 1", "Attempt 2"]);
    expect(within(panel).getByText("fail")).toBeTruthy();
    expect(within(panel).getByText("add.sh printed 0, expected 5")).toBeTruthy();
    expect(within(panel).queryByText("FAIL test_add.sh")).toBeNull();
    const toggle = within(panel).getByRole("button", { name: /show evidence \(2\)/i });
    fireEvent.click(toggle);
    expect(within(panel).getByText("FAIL test_add.sh")).toBeTruthy();
    // evidence is text, never markup
    expect(panel.querySelector("b")).toBeNull();
    expect(within(panel).getByText(/<b>not html<\/b>/)).toBeTruthy();
  });

  test("switching to another attempt tab shows that attempt", async () => {
    const two: Dashboard = {
      ...stalledRun,
      attempts: [
        {
          unit_id: "T2",
          attempt: 1,
          status: "failed",
          gates: [{ gate: "lint", verdict: "fail", reason: "R1 first reason", evidence: [] }],
        },
        {
          unit_id: "T2",
          attempt: 2,
          status: "accepted",
          gates: [{ gate: "lint", verdict: "pass", reason: "R2 second reason", evidence: [] }],
        },
      ],
    };
    render(<Run id="r-stall" api={fakeApi(two)} />);
    await screen.findByLabelText("Unit graph");
    fireEvent.click(node("T2"));
    const panel = screen.getByRole("region", { name: "Unit T2" });
    expect(within(panel).getByText("R2 second reason")).toBeTruthy();
    expect(within(panel).queryByText("R1 first reason")).toBeNull();
    const tab1 = within(panel).getByRole("tab", { name: "Attempt 1" });
    expect(tab1.getAttribute("aria-selected")).toBe("false");
    fireEvent.mouseDown(tab1, { button: 0 });
    expect(tab1.getAttribute("aria-selected")).toBe("true");
    expect(within(panel).getByText("R1 first reason")).toBeTruthy();
    expect(within(panel).queryByText("R2 second reason")).toBeNull();
  });

  test('a unit not in the current plan is labeled "not in current plan"', async () => {
    render(<Run id="r-drop" api={fakeApi(droppedUnitRun)} />);
    await screen.findByLabelText("Unit graph");
    expect(document.querySelectorAll("[data-node]").length).toBe(1);
    const btn = screen.getByRole("button", { name: /X9/ });
    fireEvent.click(btn);
    const panel = screen.getByRole("region", { name: "Unit X9" });
    expect(within(panel).getByText("not in current plan")).toBeTruthy();
    expect(within(panel).getByText("touched too much")).toBeTruthy();
  });

  test("the selection survives a poll", async () => {
    let n = 0;
    const api: Api = {
      call: (async () => {
        n++;
        return parallelRun;
      }) as Api["call"],
    };
    render(<Run id="r-par" api={api} />);
    await screen.findByLabelText("Unit graph");
    fireEvent.click(node("T2"));
    expect(screen.getByRole("region", { name: "Unit T2" })).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2100));
    });
    expect(n).toBeGreaterThan(1);
    expect(screen.getByRole("region", { name: "Unit T2" })).toBeTruthy();
  });
});

describe("Run header and states", () => {
  test("header shows pause reason, stacked-on parent, usage and stale warning", async () => {
    render(<Run id="r/child 1" api={fakeApi(stackedChild)} />);
    await screen.findByLabelText("Unit graph");
    expect(screen.getByText("r/child 1")).toBeTruthy();
    expect(screen.getByText(/waiting for parent run r-par to land/)).toBeTruthy();
    const parent = screen.getByRole("link", { name: "r-par" });
    expect(parent.getAttribute("href")).toBe("#/run/r-par");
    expect(screen.getByText(/stale: owner n2 unreachable/i)).toBeTruthy();
    expect(screen.getByText(/plan not approved/i)).toBeTruthy();
  });

  test("usage rows and plan approval show", async () => {
    render(<Run id="r-par" api={fakeApi(parallelRun)} />);
    await screen.findByLabelText("Unit graph");
    expect(screen.getByText(/anthropic\/sonnet/).textContent).toContain("input 1200");
    expect(screen.getByText(/plan approved/i)).toBeTruthy();
    expect(screen.queryByText(/stale/i)).toBeNull();
  });

  test("usage rows show only the numeric counters, not ids or flags the daemon adds", async () => {
    const noisy: Dashboard = {
      ...parallelRun,
      usage: [{ provider: "a", model: "m", run_id: "R9", eval: false, input: 5, attempts: 2 }],
    };
    render(<Run id="r-par" api={fakeApi(noisy)} />);
    await screen.findByLabelText("Unit graph");
    const row = screen.getByText(/^a\/m/).textContent ?? "";
    expect(row).toContain("input 5");
    expect(row).not.toMatch(/run id|eval/);
  });

  test('a run with no plan shows "no plan yet"', async () => {
    render(<Run id="r-new" api={fakeApi(noPlanRun)} />);
    await screen.findByText(/no plan yet/i);
    expect(document.querySelector("[data-node]")).toBeNull();
  });

  test("an unknown run shows a not-found view", async () => {
    render(<Run id="nope" api={fakeApi(new ApiError("daemon", "no such run nope"))} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/run not found/i);
    expect(alert.textContent).toContain("no such run nope");
  });

  test("an unreachable daemon shows the banner, not not-found", async () => {
    render(<Run id="r" api={fakeApi(new ApiError("unreachable", "down"))} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("daemon is not answering");
    expect(screen.queryByText(/run not found/i)).toBeNull();
  });

  test("shows a loading line before the first response", () => {
    const api: Api = { call: (() => new Promise(() => {})) as Api["call"] };
    render(<Run id="r" api={api} />);
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });
});

describe("Run routing", () => {
  const byId: Record<string, Dashboard> = {
    "run A": { ...parallelRun, run: { ...parallelRun.run, run_id: "run A" } },
    "run/B #2": { ...stalledRun, run: { ...stalledRun.run, run_id: "run/B #2" } },
  };
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  const stub = (async (_url: unknown, init?: RequestInit) => {
    const { args } = JSON.parse(String(init?.body)) as { args: string[] };
    seen.push(args[0] ?? "");
    const d = byId[args[0] ?? ""];
    return new Response(
      JSON.stringify(d ? { ok: true, data: d } : { ok: false, error: { message: "no such run" } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    location.hash = "";
    seen.length = 0;
  });

  test("a run id with / # and spaces decodes from the hash; the api gets the exact id", async () => {
    globalThis.fetch = stub;
    location.hash = `#/run/${encodeURIComponent("run/B #2")}`;
    render(<App />);
    await screen.findByLabelText("Unit graph");
    expect(seen[0]).toBe("run/B #2");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("run/B #2");
  });

  test("navigating from run A to run B shows B's data, not A's", async () => {
    globalThis.fetch = stub;
    location.hash = "#/run/run%20A";
    render(<App />);
    await screen.findByLabelText("Unit graph");
    expect(document.querySelectorAll("[data-node]").length).toBe(3);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("run A");
    await act(async () => {
      location.hash = `#/run/${encodeURIComponent("run/B #2")}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("run/B #2"),
    );
    expect(document.querySelectorAll("[data-node]").length).toBe(2);
    expect(screen.getByRole("heading", { level: 1 }).textContent).not.toContain("run A");
    expect(seen).toContain("run/B #2");
  });
});

describe("reduced motion", () => {
  const realMatch = window.matchMedia;
  afterEach(() => {
    window.matchMedia = realMatch;
  });
  const pulse = () => node("T2").querySelector("rect:not([data-ring])")?.getAttribute("data-pulse");

  test("the running node pulses by default", async () => {
    render(<Run id="r-par" api={fakeApi(parallelRun)} />);
    await screen.findByLabelText("Unit graph");
    expect(pulse()).toBe("on");
  });

  test("with prefers-reduced-motion: reduce the running node does not pulse", async () => {
    window.matchMedia = ((q: string) => ({
      matches: q.includes("prefers-reduced-motion"),
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    render(<Run id="r-par" api={fakeApi(parallelRun)} />);
    await screen.findByLabelText("Unit graph");
    expect(pulse()).toBe("off");
  });
});
