import { describe, expect, test } from "bun:test";
import { type RouteSignals, routeTier } from "../src/router.ts";
import { task } from "./helpers.ts";

const sig = (o: Partial<RouteSignals> = {}): RouteSignals => ({
  files: 1,
  lines: 80,
  criteria: 1,
  crossProject: false,
  planner: "standard",
  ...o,
});

describe("routeTier", () => {
  test("1 file, 80 lines, 1 criterion, contained, planner standard → trivial, score 4", () => {
    const r = routeTier(task("a"), sig());
    expect(r.tier).toBe("trivial");
    expect(r.score).toBe(4);
  });

  test("the same but 3 files → standard", () => {
    expect(routeTier(task("a"), sig({ files: 3 })).tier).toBe("standard");
  });

  test("the same but 160 lines → standard", () => {
    expect(routeTier(task("a"), sig({ lines: 160 })).tier).toBe("standard");
  });

  test("the same but lane wide → standard, reasons mention the floor", () => {
    const r = routeTier(task("a", { lane: "wide" }), sig());
    expect(r.tier).toBe("standard");
    expect(r.reasons.some((x) => x.includes("lane wide floors at standard"))).toBe(true);
  });

  test("2 files, 120 lines, 1 criterion, planner standard → standard, score 6", () => {
    const r = routeTier(task("a"), sig({ files: 2, lines: 120 }));
    expect(r.tier).toBe("standard");
    expect(r.score).toBe(6);
  });

  test("5 files, 500 lines, 3 criteria, planner standard → complex, score 17", () => {
    const r = routeTier(task("a"), sig({ files: 5, lines: 500, criteria: 3 }));
    expect(r.tier).toBe("complex");
    expect(r.score).toBe(17);
  });

  test("crossProject → at least standard even at score 0", () => {
    const r = routeTier(
      task("a", { kind: "docs" }),
      sig({ files: 0, lines: 0, criteria: 0, crossProject: true, planner: "trivial" }),
    );
    expect(r.tier).toBe("standard");
    expect(r.score).toBe(1);
  });

  test("6 scope globs → complex", () => {
    const scope = ["a/**", "b/**", "c/**", "d/**", "e/**", "f/**"];
    const r = routeTier(task("a", { scope }), sig());
    expect(r.tier).toBe("complex");
    expect(r.reasons.some((x) => x.includes("scope"))).toBe(true);
  });

  test("0 files and 0 lines (all new files) with 1 criterion → trivial", () => {
    const r = routeTier(task("a"), sig({ files: 0, lines: 0 }));
    expect(r.tier).toBe("trivial");
    expect(r.score).toBe(3);
  });

  test("kind docs lowers the score by 2 and never below 0", () => {
    expect(routeTier(task("a", { kind: "docs" }), sig()).score).toBe(2);
    const r = routeTier(
      task("a", { kind: "docs" }),
      sig({ files: 0, lines: 0, criteria: 0, planner: "trivial" }),
    );
    expect(r.score).toBe(0);
  });
});
