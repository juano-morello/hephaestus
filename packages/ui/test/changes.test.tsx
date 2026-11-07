import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ApiError } from "../src/api.ts";
import { Changes } from "../src/components/changes.tsx";
import { diffSummaryEmpty, diffSummaryOk } from "./fixtures.ts";
import { stubApi } from "./stub-api.ts";

afterEach(cleanup);

describe("Changes", () => {
  test("lists files per unit with +added -removed counts and totals", async () => {
    const api = stubApi({ diffSummary: diffSummaryOk });
    render(<Changes id="r-live" api={api} />);
    await screen.findByText("test_add.sh");
    expect(api.calls[0]).toEqual(["diffSummary", "r-live"]);
    const unit = screen.getByRole("region", { name: /T1/ });
    expect(within(unit).getByText("test_add.sh").closest("li")?.textContent).toContain("+3 -1");
    expect(unit.textContent).toContain("total +5 -1");
    expect(unit.textContent).toContain("calc");
  });

  test("says renamed from, binary, partial and unavailable in words", async () => {
    render(<Changes id="r-live" api={stubApi({ diffSummary: diffSummaryOk })} />);
    await screen.findByText("test_add.sh");
    expect(screen.getByText("lib/new-name.sh").closest("li")?.textContent).toContain(
      "renamed from lib/old-name.sh",
    );
    expect(screen.getByText("logo.png").closest("li")?.textContent).toContain("binary");
    expect(screen.getByRole("region", { name: /T2/ }).textContent).toContain("partial");
    expect(screen.getByRole("region", { name: /T3/ }).textContent).toContain("unavailable");
  });

  test("shows per-project totals", async () => {
    render(<Changes id="r-live" api={stubApi({ diffSummary: diffSummaryOk })} />);
    await screen.findByText("test_add.sh");
    const projects = screen.getByRole("region", { name: /projects/i });
    expect(projects.textContent).toContain("calc");
    expect(projects.textContent).toContain("4 files");
    expect(projects.textContent).toContain("+6 -1");
  });

  test("an empty summary says nothing was accepted, and a failure shows its message", async () => {
    const { unmount } = render(
      <Changes id="r-new" api={stubApi({ diffSummary: diffSummaryEmpty })} />,
    );
    await screen.findByText(/No accepted units/);
    unmount();
    render(
      <Changes id="r-x" api={stubApi({ diffSummary: new ApiError("daemon", "no such run") })} />,
    );
    await screen.findByText(/no such run/);
  });
});
