import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ApiError } from "../src/api.ts";
import { PlanReview } from "../src/components/plan-review.tsx";
import { planDetailEmpty, planDetailFull } from "./fixtures.ts";
import { stubApi } from "./stub-api.ts";

afterEach(cleanup);

describe("PlanReview", () => {
  test("one card per task with its fields as labeled lists", async () => {
    const api = stubApi({ planDetail: planDetailFull });
    render(<PlanReview id="r-live" api={api} />);
    await screen.findByText("Write the tests");
    expect(api.calls[0]).toEqual(["planDetail", "r-live"]);
    const card = screen.getByRole("article", { name: /T1/ });
    expect(within(card).getByText("Write the tests")).toBeTruthy();
    for (const word of ["test", "calc", "contained", "standard", "one new test file"])
      expect(card.textContent).toContain(word);
    for (const label of ["Scope", "Creates", "Covers", "Produces", "Consumes"])
      expect(within(card).getByText(label)).toBeTruthy();
    expect(card.textContent).toContain("test:Add");
    expect(screen.getAllByRole("article").length).toBe(2);
  });

  test("the spec is collapsed until opened", async () => {
    render(<PlanReview id="r-live" api={stubApi({ planDetail: planDetailFull })} />);
    await screen.findByText("Write the tests");
    expect(screen.queryByText(/Second line of the spec/)).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /spec/i })[0] as HTMLElement);
    expect(screen.getByText(/Second line of the spec/)).toBeTruthy();
  });

  test("risks are listed and plan approval is said in words", async () => {
    render(<PlanReview id="r-live" api={stubApi({ planDetail: planDetailFull })} />);
    await screen.findByText("Write the tests");
    expect(screen.getByText("POSIX sh differs between platforms")).toBeTruthy();
    expect(screen.getByText(/plan approved/)).toBeTruthy();
  });

  test("the criteria table marks check and projects in words and says not covered", async () => {
    render(<PlanReview id="r-live" api={stubApi({ planDetail: planDetailFull })} />);
    await screen.findByText("Write the tests");
    const table = screen.getByRole("table", { name: /criteria/i });
    const row = (id: string) => within(table).getByText(id).closest("tr") as HTMLElement;
    expect(row("AC1").textContent).toContain("test task in calc");
    expect(row("AC1").textContent).toContain("T1");
    expect(row("AC1").textContent).toContain("T2");
    expect(row("AC2").textContent).toContain("gate lint");
    expect(row("AC2").textContent).toContain("not covered");
    expect(row("AC3").textContent).toContain("a test task");
    expect(row("AC3").textContent).toContain("not covered");
    expect(row("AC1").textContent).not.toContain("not covered");
  });

  test("an empty plan says so, and a failure shows its message", async () => {
    const { unmount } = render(
      <PlanReview id="r-new" api={stubApi({ planDetail: planDetailEmpty })} />,
    );
    await screen.findByText(/No tasks/);
    unmount();
    render(
      <PlanReview
        id="r-x"
        api={stubApi({ planDetail: new ApiError("daemon", "run r-x has no finished plan") })}
      />,
    );
    await screen.findByText(/has no finished plan/);
  });
});
