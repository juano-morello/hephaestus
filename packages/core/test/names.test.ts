import { describe, expect, test } from "bun:test";
import { closestNames } from "../src/gates/names.ts";

describe("closestNames", () => {
  test("lists only files in the same directory, nearest base name first", () => {
    expect(
      closestNames("inventory/cap.go", [
        "inventory/stack.go",
        "inventory/cap_test.go",
        "other/cap.go",
      ]),
    ).toEqual(["inventory/cap_test.go", "inventory/stack.go"]);
  });

  test("an empty directory has no neighbours", () => {
    expect(closestNames("inventory/cap.go", ["other/cap.go"])).toEqual([]);
    expect(closestNames("inventory/cap.go", [])).toEqual([]);
  });

  test("honours the limit, and root-level targets compare root-level files", () => {
    expect(closestNames("main.go", ["a.go", "b.go", "c.go", "d.go", "x/main.go"], 2)).toHaveLength(
      2,
    );
    expect(closestNames("main.go", ["x/main.go"])).toEqual([]);
  });
});
