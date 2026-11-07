import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "../src/api.ts";
import { OverviewStrip } from "../src/components/overview-strip.tsx";
import { overviewEmpty, overviewFull } from "./fixtures.ts";
import { stubApi } from "./stub-api.ts";

afterEach(cleanup);

describe("OverviewStrip", () => {
  test("shows runs by status, tokens by model and the counts", async () => {
    const api = stubApi({ overview: overviewFull });
    render(<OverviewStrip api={api} />);
    const strip = await screen.findByLabelText("Overview");
    expect(api.calls[0]).toEqual(["overview"]);
    expect(strip.textContent).toContain("finished");
    expect(strip.textContent).toContain("4");
    expect(strip.textContent).toContain("sonnet");
    expect(strip.textContent).toContain("120,000");
    expect(strip.textContent).toContain("Escalations 3");
    expect(strip.textContent).toContain("Stalls 1");
  });

  test("is absent when the call fails, and when there is nothing to show", async () => {
    const { container, unmount } = render(
      <OverviewStrip api={stubApi({ overview: new ApiError("daemon", "boom") })} />,
    );
    await waitFor(() => expect(container.textContent).toBe(""));
    unmount();
    const r = render(<OverviewStrip api={stubApi({ overview: overviewEmpty })} />);
    await new Promise((res) => setTimeout(res, 20));
    expect(r.container.textContent).toBe("");
  });

  test("a reply of the wrong shape is ignored, not a crash", async () => {
    const r = render(<OverviewStrip api={stubApi({ overview: { runs: [{ run_id: "x" }] } })} />);
    await new Promise((res) => setTimeout(res, 20));
    expect(r.container.textContent).toBe("");
  });
});
