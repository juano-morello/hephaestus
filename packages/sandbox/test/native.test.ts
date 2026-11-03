import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openSandbox } from "../src/sandbox.ts";
import { tempDir } from "./helpers.ts";

const dir = tempDir();

async function native() {
  const root = dir();
  const sb = await openSandbox({ mode: "native", hostDir: root });
  return { root: realpathSync(root), sb };
}

describe("native sandbox", () => {
  test("runs commands in the project dir", async () => {
    const { root, sb } = await native();
    expect(sb.kind).toBe("native");
    expect(sb.root).toBe(root);
    const r = await sb.exec("pwd -P; echo hi >&2; exit 2");
    expect(r).toEqual({ code: 2, stdout: `${root}\n`, stderr: "hi\n", timedOut: false });
    mkdirSync(join(root, "sub"));
    expect((await sb.exec("pwd -P", { cwd: "sub" })).stdout).toBe(`${join(root, "sub")}\n`);
    await sb.dispose();
  });

  test("commands see a scrubbed environment", async () => {
    const { root, sb } = await native();
    process.env.HEPH_TEST_SECRET = "s3cret";
    const r = await sb.exec('printf "%s|%s" "$HEPH_TEST_SECRET" "$HOME"');
    delete process.env.HEPH_TEST_SECRET;
    expect(r.stdout).toBe(`|${root}`);
  });

  test("a command past its timeout is killed", async () => {
    const { sb } = await native();
    const r = await sb.exec("sleep 5", { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
  });

  test("reads and writes inside the project, creating directories", async () => {
    const { root, sb } = await native();
    await sb.writeFile("inventory/stack.go", "package inventory\n");
    expect(readFileSync(join(root, "inventory/stack.go"), "utf8")).toBe("package inventory\n");
    expect(await sb.readFile("inventory/stack.go")).toBe("package inventory\n");
    expect(await sb.readFile(join(root, "inventory/stack.go"))).toBe("package inventory\n");
  });

  test("rejects paths and cwds outside the project", async () => {
    const { sb } = await native();
    await expect(sb.readFile("../outside.txt")).rejects.toThrow("path escapes the sandbox");
    await expect(sb.readFile("/etc/hosts")).rejects.toThrow("path escapes the sandbox");
    await expect(sb.writeFile("../../x", "x")).rejects.toThrow("path escapes the sandbox");
    await expect(sb.exec("pwd", { cwd: ".." })).rejects.toThrow("path escapes the sandbox");
  });

  test("rejects symlinks that point outside, for reads and for writes", async () => {
    const { root, sb } = await native();
    const outside = dir();
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    symlinkSync(outside, join(root, "linkdir"));
    await expect(sb.readFile("link.txt")).rejects.toThrow("path escapes the sandbox");
    await expect(sb.writeFile("link.txt", "x")).rejects.toThrow("path escapes the sandbox");
    await expect(sb.writeFile("linkdir/new.txt", "x")).rejects.toThrow("path escapes the sandbox");
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret");
  });
});
