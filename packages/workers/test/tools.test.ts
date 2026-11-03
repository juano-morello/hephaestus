import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSandbox } from "@hephaestus/sandbox";
import { createToolHandlers, TOOL_NAMES } from "../src/tools.ts";
import { tempDir } from "./helpers.ts";

const dir = tempDir();

async function tools(lockedPaths: string[] = []) {
  const root = dir();
  const sb = await openSandbox({ mode: "native", hostDir: root });
  return { root, ...createToolHandlers(sb, { lockedPaths }) };
}

describe("tool handlers", () => {
  test("exposes exactly the five worker tools", () => {
    expect(TOOL_NAMES).toEqual(["read", "write", "edit", "bash", "submit_result"]);
  });

  test("read numbers lines and honours offset and limit", async () => {
    const { root, handlers } = await tools();
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
    expect(await handlers.read({ path: "a.txt" })).toBe("1\tone\n2\ttwo\n3\tthree");
    expect(await handlers.read({ path: "a.txt", offset: 2, limit: 1 })).toBe("2\ttwo");
    writeFileSync(join(root, "empty.txt"), "");
    expect(await handlers.read({ path: "empty.txt" })).toBe("(empty file)");
    await expect(handlers.read({ path: "../x" })).rejects.toThrow("path escapes the sandbox");
  });

  test("write creates directories and reports what it wrote", async () => {
    const { root, handlers } = await tools();
    expect(await handlers.write({ path: "pkg/a.go", content: "package a\n" })).toBe(
      "wrote pkg/a.go (10 bytes)",
    );
    expect(readFileSync(join(root, "pkg/a.go"), "utf8")).toBe("package a\n");
  });

  test("edit needs a unique match unless replace_all is set", async () => {
    const { root, handlers } = await tools();
    writeFileSync(join(root, "a.go"), "x := 1\ny := 1\n");
    await expect(handlers.edit({ path: "a.go", old_string: "1", new_string: "2" })).rejects.toThrow(
      "old_string matches 2 times in a.go; make it unique or set replace_all",
    );
    await expect(handlers.edit({ path: "a.go", old_string: "z", new_string: "2" })).rejects.toThrow(
      "old_string not found in a.go",
    );
    expect(await handlers.edit({ path: "a.go", old_string: "x := 1", new_string: "x := 2" })).toBe(
      "edited a.go (1 replacement)",
    );
    expect(
      await handlers.edit({ path: "a.go", old_string: "1", new_string: "3", replace_all: true }),
    ).toBe("edited a.go (1 replacement)");
    expect(readFileSync(join(root, "a.go"), "utf8")).toBe("x := 2\ny := 3\n");
  });

  test("write and edit refuse locked paths", async () => {
    const { root, handlers } = await tools(["a_test.go"]);
    writeFileSync(join(root, "a_test.go"), "package a\n");
    const msg = "a_test.go is locked (a test from an earlier unit); if it is wrong, report blocked";
    await expect(handlers.write({ path: "a_test.go", content: "x" })).rejects.toThrow(msg);
    await expect(
      handlers.edit({ path: "./a_test.go", old_string: "a", new_string: "b" }),
    ).rejects.toThrow(msg);
  });

  test("bash reports the exit code and combined output, truncated", async () => {
    const { handlers } = await tools();
    expect(await handlers.bash({ command: "echo out; echo err >&2; exit 3" })).toBe(
      "exit 3\nout\n[stderr]\nerr\n",
    );
    expect(await handlers.bash({ command: "sleep 5; true", timeout_ms: 200 })).toStartWith(
      "exit 137 (timed out)",
    );
    const long = await handlers.bash({ command: "yes x | head -c 100000" });
    expect(long.length).toBeLessThan(31_000);
    expect(long).toContain("[... truncated ");
  });

  test("submit_result records a valid WorkerResult once", async () => {
    const { handlers, result } = await tools();
    await expect(
      handlers.submit_result({ summary: "s", claims: "nope" as unknown as string[], touched: [] }),
    ).rejects.toThrow("invalid result");
    expect(
      await handlers.submit_result({
        summary: "done",
        claims: ["cap enforced"],
        touched: ["a.go"],
      }),
    ).toBe("result recorded");
    expect(result()).toEqual({
      schema: 1,
      summary: "done",
      claims: ["cap enforced"],
      touched: ["a.go"],
    });
    await expect(
      handlers.submit_result({ summary: "again", claims: [], touched: [] }),
    ).rejects.toThrow("result already submitted");
  });

  test("submit_result with blocked_reason is an honest exit", async () => {
    const { handlers, result } = await tools();
    await handlers.submit_result({
      summary: "",
      claims: [],
      touched: [],
      blocked_reason: "test expects 51",
    });
    expect(result()?.blocked).toEqual({ reason: "test expects 51" });
  });
});
