import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { type Api, ApiError } from "../src/api.ts";
import { StatusBadge } from "../src/components/status-badge.tsx";
import { Runs } from "../src/views/runs.tsx";
import { type StatusListFixture, statusList } from "./fixtures.ts";

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
