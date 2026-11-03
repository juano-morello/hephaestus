import { describe, expect, test } from "bun:test";
import { resolveInside } from "../src/paths.ts";

describe("resolveInside", () => {
  const ok: [string, string][] = [
    ["a.go", "/work/a.go"],
    ["./inventory/../a.go", "/work/a.go"],
    ["/work/sub/x.txt", "/work/sub/x.txt"],
    [".", "/work"],
    ["", "/work"],
  ];
  for (const [input, want] of ok) {
    test(`${JSON.stringify(input)} -> ${want}`, () => {
      expect(resolveInside("/work", input)).toBe(want);
    });
  }

  for (const bad of ["../etc/passwd", "/etc/passwd", "a/../../x", "/workspace/x", "/work/../etc"]) {
    test(`rejects ${bad}`, () => {
      expect(() => resolveInside("/work", bad)).toThrow(`path escapes the sandbox: ${bad}`);
    });
  }

  test("works with a trailing slash on the root", () => {
    expect(resolveInside("/work/", "a")).toBe("/work/a");
  });
});
