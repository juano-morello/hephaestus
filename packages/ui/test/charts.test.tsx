import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import { Charts } from "../src/components/charts.tsx";
import { runChartsEmpty, runChartsFull } from "./fixtures.ts";
import { stubApi } from "./stub-api.ts";

afterEach(cleanup);

describe("Charts", () => {
  test("attempt outcomes are glyph plus word, per unit", async () => {
    const api = stubApi({ runCharts: runChartsFull });
    render(<Charts id="r-live" api={api} />);
    await screen.findByLabelText(/attempts of T2/i);
    expect(api.calls[0]).toEqual(["runCharts", "r-live"]);
    const t2 = screen.getByLabelText(/attempts of T2/i);
    for (const word of ["red", "blocked", "error", "none yet"])
      expect(t2.textContent).toContain(word);
    expect(screen.getByLabelText(/attempts of T1/i).textContent).toContain("✓");
    expect(t2.textContent).toContain("✗");
  });

  test("tokens by model are printed as numbers beside the bars", async () => {
    render(<Charts id="r-live" api={stubApi({ runCharts: runChartsFull })} />);
    await screen.findByLabelText(/attempts of T2/i);
    const bars = screen.getByRole("list", { name: /tokens by model/i });
    expect(bars.textContent).toContain("sonnet");
    expect(bars.textContent).toContain("2,100"); // 1200 + 900 input
    expect(bars.textContent).toContain("640"); // 340 + 300 output
    expect(bars.textContent).toContain("opus");
    expect(bars.textContent).toContain("800");
  });

  test("escalation and stall counts are shown", async () => {
    render(<Charts id="r-live" api={stubApi({ runCharts: runChartsFull })} />);
    await screen.findByLabelText(/attempts of T2/i);
    expect(screen.getByText(/Escalations/).textContent).toContain("1");
    expect(screen.getByText(/Stalls/).textContent).toContain("2");
  });

  test("every chart has a visually hidden data table with the same data", async () => {
    render(<Charts id="r-live" api={stubApi({ runCharts: runChartsFull })} />);
    await screen.findByLabelText(/attempts of T2/i);
    const attempts = screen.getByRole("table", { name: /attempts data/i });
    expect(attempts.className).toContain("sr-only");
    expect(within(attempts).getAllByRole("row").length).toBe(1 + 5);
    const tokens = screen.getByRole("table", { name: /tokens data/i });
    expect(tokens.className).toContain("sr-only");
    expect(within(tokens).getAllByRole("row").length).toBe(1 + 3);
    expect(tokens.textContent).toContain("5000");
  });

  test("a run with no attempts renders empty states", async () => {
    render(<Charts id="r-new" api={stubApi({ runCharts: runChartsEmpty })} />);
    await screen.findByText(/No attempts yet/);
    expect(screen.getByText(/Escalations/).textContent).toContain("0");
  });
});
