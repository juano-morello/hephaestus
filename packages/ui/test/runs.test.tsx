import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { type Api, ApiError } from "../src/api.ts";
import { StatusBadge } from "../src/components/status-badge.tsx";
import { Runs } from "../src/views/runs.tsx";
import { overviewFull, type StatusListFixture, statusList } from "./fixtures.ts";
import { stubApi } from "./stub-api.ts";

afterEach(cleanup);

const fakeApi = (result: StatusListFixture | ApiError): Api & { calls: unknown[][] } => {
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

describe("Runs", () => {
  test("lists every run with id, status badge and stacked-on parent", async () => {
    const api = fakeApi(statusList);
    render(<Runs api={api} />);
    await screen.findByText("r-old");
    expect(api.calls[0]).toEqual(["status"]);
    for (const id of ["r-old", "r-live", "r/child 1"]) {
      expect(screen.getAllByText(id).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByText("paused")).toBeTruthy();
    expect(screen.getByText("finished")).toBeTruthy();
    const child = screen.getByText("r/child 1").closest("tr");
    expect(child?.textContent).toContain("r-live");
  });

  test("orders rows by most recently updated first", async () => {
    render(<Runs api={fakeApi(statusList)} />);
    await screen.findByText("r-old");
    const ids = screen.getAllByRole("link").map((a) => a.textContent);
    expect(ids).toEqual(["r-live", "r/child 1", "r-old"]);
  });

  test("a row link points to #/run/<encoded id>", async () => {
    render(<Runs api={fakeApi(statusList)} />);
    const link = await screen.findByRole("link", { name: "r/child 1" });
    expect(link.getAttribute("href")).toBe("#/run/r%2Fchild%201");
  });

  test("shows the daemon-unreachable banner when the call fails", async () => {
    render(<Runs api={fakeApi(new ApiError("unreachable", "down"))} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("daemon is not answering");
  });

  test('shows "no runs yet" for an empty list', async () => {
    render(<Runs api={fakeApi({ runs: [] })} />);
    await waitFor(() => expect(screen.getByText(/no runs yet/i)).toBeTruthy());
  });
});

describe("Runs states", () => {
  test("shows a loading line before the first response", async () => {
    const api: Api = { call: (() => new Promise(() => {})) as Api["call"] };
    render(<Runs api={api} />);
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  test("a plain Error from the api renders exactly one alert", async () => {
    const api: Api = {
      call: (async () => {
        throw new Error("boom");
      }) as Api["call"],
    };
    render(<Runs api={api} />);
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.length).toBe(1);
    expect(alerts[0]?.textContent).toContain("boom");
  });

  test("a daemon error renders exactly one alert", async () => {
    render(<Runs api={fakeApi(new ApiError("daemon", "no such thing"))} />);
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.length).toBe(1);
  });
});

describe("row highlight", () => {
  test("focusing the row link highlights the row, blur clears it", async () => {
    render(<Runs api={fakeApi(statusList)} />);
    const link = await screen.findByRole("link", { name: "r-live" });
    const row = link.closest("tr");
    expect(row?.getAttribute("data-highlighted")).toBe("false");
    await act(async () => {
      link.focus();
    });
    expect(row?.getAttribute("data-highlighted")).toBe("true");
    await act(async () => {
      link.blur();
    });
    expect(row?.getAttribute("data-highlighted")).toBe("false");
  });
});

describe("reduced motion", () => {
  const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
  const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

  test("the reduced-motion rule turns the running pulse off", () => {
    expect(block).toMatch(/\.heph-pulse\s*\{[^}]*animation:\s*none/);
  });

  test("the row highlight honors the user's reduced-motion setting", () => {
    const src = readFileSync(
      new URL("../src/components/animate-ui/highlight-row.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toContain('reducedMotion="user"');
  });
});

describe("StatusBadge", () => {
  test("always carries a text label, not just a color", () => {
    for (const s of [
      "running",
      "staged",
      "landed",
      "finished",
      "paused",
      "escalated",
      "failed",
      "created",
      "weird",
    ]) {
      const { container, unmount } = render(<StatusBadge status={s} />);
      expect(container.textContent).toContain(s);
      expect(container.querySelector("svg, [data-icon]")).toBeTruthy();
      unmount();
    }
  });
});

describe("StatusBadge lookup", () => {
  test("inherited object keys fall back to the neutral tone", () => {
    for (const s of ["constructor", "toString", "__proto__"]) {
      const { container, unmount } = render(<StatusBadge status={s} />);
      expect(container.textContent).toContain(s);
      expect(container.querySelector("span")?.className).toContain("text-muted");
      unmount();
    }
  });
});

describe("Runs overview strip", () => {
  test("shows the overview above the table when it answers", async () => {
    const api = stubApi({ status: statusList, overview: overviewFull });
    render(<Runs api={api} />);
    await screen.findByLabelText("Overview");
    expect(api.calls.map((c) => c[0])).toContain("overview");
    expect(screen.getByRole("table")).toBeTruthy();
  });

  test("the runs table still shows when overview fails, and no strip", async () => {
    render(<Runs api={stubApi({ status: statusList, overview: new ApiError("daemon", "x") })} />);
    await screen.findByRole("table");
    expect(screen.queryByLabelText("Overview")).toBeNull();
  });
});
