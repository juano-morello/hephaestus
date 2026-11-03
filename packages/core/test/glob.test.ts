import { describe, expect, test } from "bun:test";
import { globsOverlap } from "../src/gates/glob.ts";

describe("globsOverlap", () => {
  const cases: [string, string, boolean][] = [
    ["inventory/stack.go", "inventory/stack.go", true],
    ["inventory/stack.go", "inventory/cap.go", false],
    ["inventory/**", "loot/**", false],
    ["inventory/**", "inventory/stack.go", true],
    ["inventory/**/*.go", "inventory/sub/stack_test.go", true],
    ["inventory/*_test.go", "inventory/stack.go", false],
    ["inventory/*_test.go", "inventory/*.go", true],
    ["inventory/*.go", "inventory/*.ts", false],
    ["**/*.go", "net/handler.go", true],
    ["**/*.go", "net/handler.gd", false],
    ["inventory/*.go", "inventory/sub/stack.go", false],
    ["net/{loot,drop}.go", "net/loot.go", true],
    ["net/{loot,drop}.go", "net/chat.go", false],
    ["gen/**", "gen/go/loot.pb.go", true],
  ];
  for (const [a, b, expected] of cases) {
    test(`${a} vs ${b} -> ${expected}`, () => {
      expect(globsOverlap(a, b)).toBe(expected);
      expect(globsOverlap(b, a)).toBe(expected);
    });
  }
});
